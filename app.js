const express = require('express');
const stripe  = require('stripe')(process.env.STRIPE_SECRET_KEY || '');
const app     = express();

// ── FIREBASE ADMIN SDK ────────────────────────────────────────────────────────
// Set FIREBASE_SERVICE_ACCOUNT env var in Railway with the JSON service account key
let _fbAdmin = null;
let _fbDb    = null;

function initFirebase(){
  try {
    const admin = require('firebase-admin');
    if(admin.apps.length){ _fbAdmin = admin; _fbDb = admin.firestore(); return; }
    const sa = process.env.FIREBASE_SERVICE_ACCOUNT;
    if(!sa){ console.warn('FIREBASE_SERVICE_ACCOUNT not set — Firestore unavailable'); return; }
    const serviceAccount = JSON.parse(sa);
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    _fbAdmin = admin;
    _fbDb    = admin.firestore();
    console.log('Firebase Admin SDK initialized');
  } catch(e){
    console.warn('Firebase Admin init failed:', e.message);
  }
}
initFirebase();

// ── IN-MEMORY STORE (fallback when Firebase unavailable) ─────────────────────
// ADMIN_PASS env var = most reliable — persists across Railway restarts
// _memPassword = set via API call — lost on restart unless Firebase saves it
let _memPassword   = process.env.ADMIN_PASS || '';
let eventQueue     = [];
let approvedEvents = [];
let teamMembers    = [];

// ── HELPERS: read/write password via Firestore with memory fallback ───────────
async function getAdminPassword(){
  // 1. Memory first (set via API this session, or from ADMIN_PASS env var)
  if(_memPassword) return _memPassword;
  // 2. Firestore (persists across restarts if Firebase Admin is working)
  if(_fbDb){
    try {
      const doc = await _fbDb.collection('config').doc('adminAuth').get();
      if(doc.exists && doc.data().password){
        _memPassword = doc.data().password; // cache it
        return _memPassword;
      }
    } catch(e){ console.warn('getAdminPassword Firestore err:', e.message); }
  }
  // 3. ADMIN_PASS env var (Railway Variable — most reliable)
  return process.env.ADMIN_PASS || '';
}

async function setAdminPassword(password){
  _memPassword = password; // always update memory cache
  let firestoreOk = false;
  if(_fbDb){
    try {
      await _fbDb.collection('config').doc('adminAuth').set({
        password,
        updatedAt: _fbAdmin.firestore.FieldValue.serverTimestamp()
      });
      firestoreOk = true;
      console.log('Password saved to Firestore successfully');
    } catch(e){ console.warn('setAdminPassword Firestore err:', e.message); }
  } else {
    console.warn('Firebase not available — password in memory only (set ADMIN_PASS env var for persistence)');
  }
  return firestoreOk;
}

// ── CORS ─────────────────────────────────────────────────────────────────────
app.use(function(req, res, next){
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,x-admin-key');
  if(req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ── ADMIN AUTH MIDDLEWARE ─────────────────────────────────────────────────────
function requireAdmin(req, res, next){
  const key    = req.headers['x-admin-key'] || (req.body && req.body.adminKey) || '';
  const secret = process.env.ADMIN_SECRET   || '';
  if(!secret)  return next();           // dev mode — no secret set
  if(key !== secret) return res.status(401).json({ error:'Unauthorized' });
  next();
}

// ── HEALTH CHECK ─────────────────────────────────────────────────────────────
app.get('/', express.json(), (req, res) => {
  res.json({
    status:        'SpangledAI backend running',
    timestamp:     new Date(),
    firebase:      !!_fbDb,
    queueLength:   eventQueue.length,
    approvedCount: approvedEvents.length,
    teamCount:     teamMembers.length
  });
});

// ── DEBUG — check password state (remove in production) ──────────────────────
app.get('/admin/debug', express.json(), requireAdmin, async (req, res) => {
  const stored = await getAdminPassword();
  res.json({
    firebase:        !!_fbDb,
    memoryPassword:  _memPassword ? '✓ set ('+_memPassword.length+' chars)' : '✗ empty',
    firestoreCheck:  stored       ? '✓ found' : '✗ not found',
    envAdminPass:    process.env.ADMIN_PASS ? '✓ set' : '✗ not set',
    adminSecretSet:  process.env.ADMIN_SECRET ? '✓ set' : '✗ not set'
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// PASSWORD — persistent via Firestore, memory fallback
// ═════════════════════════════════════════════════════════════════════════════

// POST /admin/set-password
app.post('/admin/set-password', express.json(), requireAdmin, async (req, res) => {
  const { password } = req.body;
  if(!password || !password.trim())
    return res.status(400).json({ error:'Password cannot be empty' });
  const savedToFirestore = await setAdminPassword(password.trim());
  console.log('Admin password updated. Firestore:', savedToFirestore);
  res.json({
    ok: true,
    persistent: savedToFirestore,
    message: savedToFirestore
      ? '✓ Password saved to Firestore — persists across restarts.'
      : '✓ Password saved in memory — set FIREBASE_SERVICE_ACCOUNT for persistence.'
  });
});

// POST /admin/check-password
app.post('/admin/check-password', express.json(), async (req, res) => {
  const { password } = req.body;
  const stored = await getAdminPassword();
  console.log('check-password: stored='+(stored?'SET':'EMPTY')+
    ' firebase='+(!!_fbDb)+' memPw='+(!!_memPassword)+
    ' envPw='+(!!process.env.ADMIN_PASS));
  if(!stored)
    return res.json({ ok:false,
      message:'⚠️ No password set. In Railway → Variables, add ADMIN_PASS=YourPassword then redeploy.' });
  res.json({ ok: password === stored, message: '✗ Incorrect password.' });
});

// ═════════════════════════════════════════════════════════════════════════════
// STRIPE CHECKOUT — creates session with Firebase uid in metadata
// ═════════════════════════════════════════════════════════════════════════════

// POST /create-checkout — app calls this when user taps $5.99
app.post('/create-checkout', express.json(), async (req, res) => {
  const { uid, successUrl, cancelUrl } = req.body;
  const priceId = process.env.STRIPE_PRICE_ID || '';
  if(!priceId){
    return res.status(400).json({
      error: 'STRIPE_PRICE_ID not set in Railway env vars.',
      message: 'Add STRIPE_PRICE_ID to Railway Variables (get it from Stripe Dashboard → Products).'
    });
  }
  try {
    const session = await stripe.checkout.sessions.create({
      mode:                'payment',
      payment_method_types:['card'],
      line_items: [{
        price:    priceId,
        quantity: 1
      }],
      metadata: {
        firebaseUid: uid || '',
        product:     'SpangledAI Premium'
      },
      client_reference_id: uid || '',
      success_url: successUrl || 'https://starspangledbanner.star.spangledai.com?premium=success',
      cancel_url:  cancelUrl  || 'https://starspangledbanner.star.spangledai.com?premium=cancel'
    });
    console.log('Checkout session created for uid:', uid, 'session:', session.id);
    res.json({ url: session.url, sessionId: session.id });
  } catch(e) {
    console.error('Checkout error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// EVENTS — PUBLIC
// ═════════════════════════════════════════════════════════════════════════════

app.get('/events', async (req, res) => {
  // Try Firestore first
  if(_fbDb){
    try {
      const snap = await _fbDb.collection('approvedEvents').get();
      const events = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      return res.json({ events, count: events.length, source:'firestore' });
    } catch(e){ console.warn('GET /events Firestore err:', e.message); }
  }
  res.json({ events: approvedEvents, count: approvedEvents.length, source:'memory' });
});

app.post('/submit-event', express.json({ limit:'2mb' }), async (req, res) => {
  const { name, city, state } = req.body;
  if(!name || !city || !state)
    return res.status(400).json({ error:'name, city, state required' });
  const item = {
    id:         'q_' + Date.now() + '_' + Math.random().toString(36).slice(2,7),
    name,       org:     req.body.org     || '',
    loc:        req.body.loc     || '',
    city,       state,
    date:       req.body.date    || 'July 4, 2026',
    time:       req.body.time    || '',
    website:    req.body.website || '',
    desc:       req.body.desc    || '',
    type:       req.body.type    || 'Community Event',
    lat:        parseFloat(req.body.lat)  || null,
    lng:        parseFloat(req.body.lng)  || null,
    _source:    'Pyro Portal',
    _submitted: new Date().toISOString()
  };
  // Write to Firestore if available, otherwise memory
  if(_fbDb){
    try {
      await _fbDb.collection('eventQueue').doc(item.id).set(item);
    } catch(e){
      eventQueue.push(item);
      console.warn('submit-event Firestore err — memory fallback:', e.message);
    }
  } else {
    eventQueue.push(item);
  }
  console.log('New submission:', item.name, item.city, item.state);
  res.json({ ok:true, id:item.id, message:'Submission received — pending admin review.' });
});

// ═════════════════════════════════════════════════════════════════════════════
// EVENTS — ADMIN
// ═════════════════════════════════════════════════════════════════════════════

app.get('/admin/queue', express.json(), requireAdmin, async (req, res) => {
  if(_fbDb){
    try {
      const snap = await _fbDb.collection('eventQueue').get();
      return res.json({ queue: snap.docs.map(d=>({id:d.id,...d.data()})) });
    } catch(e){ console.warn('admin/queue Firestore err:', e.message); }
  }
  res.json({ queue: eventQueue });
});

app.post('/admin/approve/:id', express.json(), requireAdmin, async (req, res) => {
  const id = req.params.id;
  let ev = null;
  if(_fbDb){
    try {
      const doc = await _fbDb.collection('eventQueue').doc(id).get();
      if(!doc.exists) return res.status(404).json({ error:'Not found in queue' });
      ev = { id, ...doc.data() };
      ev._approved   = new Date().toISOString();
      ev._approvedBy = (req.body && req.body.approvedBy) || 'admin';
      await _fbDb.collection('approvedEvents').doc(id).set(ev);
      await _fbDb.collection('eventQueue').doc(id).delete();
    } catch(e){ return res.status(500).json({ error: e.message }); }
  } else {
    const idx = eventQueue.findIndex(e => e.id === id);
    if(idx < 0) return res.status(404).json({ error:'Not found' });
    ev = eventQueue.splice(idx,1)[0];
    ev._approved = new Date().toISOString();
    approvedEvents.push(ev);
  }
  console.log('APPROVED:', ev.name);
  res.json({ ok:true, event:ev });
});

app.post('/admin/reject/:id', express.json(), requireAdmin, async (req, res) => {
  const id = req.params.id;
  if(_fbDb){
    try {
      const doc = await _fbDb.collection('eventQueue').doc(id).get();
      if(!doc.exists) return res.status(404).json({ error:'Not found' });
      const name = doc.data().name;
      await _fbDb.collection('eventQueue').doc(id).delete();
      return res.json({ ok:true, removed:name });
    } catch(e){ return res.status(500).json({ error:e.message }); }
  }
  const idx = eventQueue.findIndex(e => e.id===id);
  if(idx<0) return res.status(404).json({ error:'Not found' });
  const ev = eventQueue.splice(idx,1)[0];
  res.json({ ok:true, removed:ev.name });
});

app.delete('/admin/event/:id', express.json(), requireAdmin, async (req, res) => {
  const id = req.params.id;
  if(_fbDb){
    try {
      await _fbDb.collection('approvedEvents').doc(id).delete();
      return res.json({ ok:true });
    } catch(e){ return res.status(500).json({ error:e.message }); }
  }
  const idx = approvedEvents.findIndex(e=>e.id===id);
  if(idx<0) return res.status(404).json({ error:'Not found' });
  approvedEvents.splice(idx,1);
  res.json({ ok:true });
});

app.post('/admin/add-event', express.json({ limit:'2mb' }), requireAdmin, async (req, res) => {
  const { name, city, state } = req.body;
  if(!name||!city||!state) return res.status(400).json({ error:'name, city, state required' });
  const ev = {
    id: 'adm_'+Date.now(),
    ...req.body,
    _source:    'Admin Manual Add',
    _approved:  new Date().toISOString(),
    _approvedBy:(req.body && req.body.approvedBy)||'admin'
  };
  if(_fbDb){
    try { await _fbDb.collection('approvedEvents').doc(ev.id).set(ev); }
    catch(e){ approvedEvents.push(ev); }
  } else { approvedEvents.push(ev); }
  res.json({ ok:true, event:ev });
});

// ═════════════════════════════════════════════════════════════════════════════
// TEAM / PERMISSIONS
// ═════════════════════════════════════════════════════════════════════════════

app.get('/admin/team', express.json(), requireAdmin, async (req, res) => {
  if(_fbDb){
    try {
      const snap = await _fbDb.collection('team').get();
      return res.json({ team: snap.docs.map(d=>({id:d.id,...d.data()})) });
    } catch(e){ console.warn('team get err:', e.message); }
  }
  res.json({ team: teamMembers });
});

app.post('/admin/team', express.json(), requireAdmin, async (req, res) => {
  const { name, email, role, permissions } = req.body;
  if(!name||!email) return res.status(400).json({ error:'name and email required' });
  const member = {
    id:          'mbr_'+Date.now(),
    name, email, role: role||'Curator',
    permissions: permissions||{ viewQueue:true, approveEvents:false,
      rejectEvents:false, manualAdd:false, viewAnalytics:false,
      manageTeam:false, premiumAccess:false },
    _added:   new Date().toISOString(),
    _updated: new Date().toISOString()
  };
  if(_fbDb){
    try {
      // Upsert by email
      const snap = await _fbDb.collection('team').where('email','==',email).get();
      const docId = snap.empty ? member.id : snap.docs[0].id;
      if(!snap.empty) member.id = docId;
      await _fbDb.collection('team').doc(docId).set(member, {merge:true});
      return res.json({ ok:true, member });
    } catch(e){ console.warn('team post err:', e.message); }
  }
  const idx = teamMembers.findIndex(m=>m.email===email);
  if(idx>=0) teamMembers[idx]=member; else teamMembers.push(member);
  res.json({ ok:true, member });
});

app.delete('/admin/team/:id', express.json(), requireAdmin, async (req, res) => {
  const id = req.params.id;
  if(_fbDb){
    try { await _fbDb.collection('team').doc(id).delete(); return res.json({ok:true}); }
    catch(e){ console.warn('team del err:', e.message); }
  }
  teamMembers = teamMembers.filter(m=>m.id!==id);
  res.json({ ok:true });
});

// ═════════════════════════════════════════════════════════════════════════════
// PREMIUM — grant from Stripe webhook
// ═════════════════════════════════════════════════════════════════════════════

app.post('/webhook', express.raw({ type:'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body, sig, process.env.STRIPE_WEBHOOK_SECRET||'');
  } catch(e){ return res.status(400).send('Webhook Error: '+e.message); }

  if(event.type==='checkout.session.completed' ||
     event.type==='payment_intent.succeeded'){
    const obj      = event.data.object;
    const uid      = obj.metadata && obj.metadata.firebaseUid;
    const email    = obj.customer_email || (obj.charges && obj.charges.data[0] &&
                     obj.charges.data[0].billing_details &&
                     obj.charges.data[0].billing_details.email) || '';
    console.log('Payment success — uid:', uid, 'email:', email);
    if(_fbDb && uid){
      try {
        await _fbDb.collection('users').doc(uid).set({
          premium:   true,
          grantedAt: _fbAdmin.firestore.FieldValue.serverTimestamp(),
          email,
          platform: 'web'
        }, { merge:true });
        console.log('Premium granted in Firestore for uid:', uid);
      } catch(e){ console.warn('Premium Firestore write err:', e.message); }
    }
  }
  res.json({ received:true });
});


// ═════════════════════════════════════════════════════════════════════════════
// AMERICA 250 EVENTS FEED
// ═════════════════════════════════════════════════════════════════════════════

// Seed list — major confirmed America 250 / July 4 2026 events
const A250_SEED_EVENTS = [
  { id:'a250_001', name:'National Independence Day Parade',
    org:'National Park Service', city:'Washington', state:'DC',
    date:'July 4, 2026', time:'11:45 AM',
    lat:38.8921, lng:-77.0241, type:'Parade',
    desc:'The official national parade down Constitution Avenue celebrating America\'s 250th birthday.',
    website:'https://july4thparade.com' },
  { id:'a250_002', name:'A Capitol Fourth Concert',
    org:'PBS / National Park Service', city:'Washington', state:'DC',
    date:'July 4, 2026', time:'8:00 PM',
    lat:38.8893, lng:-77.0501, type:'Concert',
    desc:'Live concert on the US Capitol lawn with fireworks over the National Mall.',
    website:'https://pbs.org/a-capitol-fourth' },
  { id:'a250_003', name:'Boston Harborfest & Pops Fireworks Spectacular',
    org:'Boston Symphony Orchestra', city:'Boston', state:'MA',
    date:'July 4, 2026', time:'8:00 PM',
    lat:42.3607, lng:-71.0744, type:'Concert',
    desc:'The legendary Boston Pops concert on the Esplanade followed by fireworks over the Charles River.',
    website:'https://bso.org' },
  { id:'a250_004', name:'Macy\'s 4th of July Fireworks',
    org:'Macy\'s', city:'New York', state:'NY',
    date:'July 4, 2026', time:'9:25 PM',
    lat:40.7282, lng:-74.0080, type:'Fireworks Show',
    desc:'America\'s largest fireworks display over New York Harbor — 60,000 shells over 25 minutes.',
    website:'https://macys.com/fireworks' },
  { id:'a250_005', name:'Nashville Fourth of July',
    org:'Nashville Convention & Visitors Corp', city:'Nashville', state:'TN',
    date:'July 4, 2026', time:'5:00 PM',
    lat:36.1627, lng:-86.7816, type:'Festival',
    desc:'All-day festival with live country music, food, and one of the largest fireworks shows in the South.',
    website:'https://visitmusiccity.com' },
  { id:'a250_006', name:'Philadelphia July 4th Festival',
    org:'Philadelphia 4th of July Committee', city:'Philadelphia', state:'PA',
    date:'July 4, 2026', time:'6:00 PM',
    lat:39.9526, lng:-75.1652, type:'Festival',
    desc:'Celebration in the birthplace of American independence — concerts, fireworks, and historic ceremony.',
    website:'https://welcomeamerica.com' },
  { id:'a250_007', name:'Chicago Lakefront Fireworks',
    org:'City of Chicago', city:'Chicago', state:'IL',
    date:'July 3, 2026', time:'9:30 PM',
    lat:41.8827, lng:-87.6233, type:'Fireworks Show',
    desc:'Spectacular fireworks display over Lake Michigan at Navy Pier.',
    website:'https://chicago.gov' },
  { id:'a250_008', name:'Houston Freedom Over Texas',
    org:'ABC13 / City of Houston', city:'Houston', state:'TX',
    date:'July 4, 2026', time:'7:00 PM',
    lat:29.7604, lng:-95.3698, type:'Festival',
    desc:'Texas-sized celebration with live music and fireworks at Eleanor Tinsley Park.',
    website:'https://freedomovertexas.com' },
  { id:'a250_009', name:'San Francisco July 4th Fireworks',
    org:'City of San Francisco', city:'San Francisco', state:'CA',
    date:'July 4, 2026', time:'9:30 PM',
    lat:37.8079, lng:-122.4177, type:'Fireworks Show',
    desc:'Fireworks over the San Francisco Bay visible from Fisherman\'s Wharf and the waterfront.',
    website:'https://sftravel.com' },
  { id:'a250_010', name:'Los Angeles Grand Park 4th of July',
    org:'Grand Park LA', city:'Los Angeles', state:'CA',
    date:'July 4, 2026', time:'4:00 PM',
    lat:34.0564, lng:-118.2429, type:'Festival',
    desc:'Free public celebration in the heart of downtown LA with music, food, and fireworks.',
    website:'https://grandparkla.org' },
  { id:'a250_011', name:'Atlanta Peachtree Road Race & Celebration',
    org:'Atlanta Track Club', city:'Atlanta', state:'GA',
    date:'July 4, 2026', time:'7:00 AM',
    lat:33.8490, lng:-84.3788, type:'Community Event',
    desc:'The world\'s largest 10K road race, followed by fireworks at Centennial Olympic Park.',
    website:'https://peachtreeroadrace.org' },
  { id:'a250_012', name:'Seattle Seafair 4th of July',
    org:'City of Seattle', city:'Seattle', state:'WA',
    date:'July 4, 2026', time:'10:20 PM',
    lat:47.6062, lng:-122.3321, type:'Fireworks Show',
    desc:'Fireworks over Lake Union visible from Gas Works Park and surrounding neighborhoods.',
    website:'https://seafair.org' },
  { id:'a250_013', name:'Denver America 250 Celebration',
    org:'City of Denver', city:'Denver', state:'CO',
    date:'July 4, 2026', time:'6:00 PM',
    lat:39.7392, lng:-104.9903, type:'Festival',
    desc:'Mile High celebration with concerts and fireworks at Civic Center Park.',
    website:'https://denver.gov' },
  { id:'a250_014', name:'New Orleans 4th of July on the River',
    org:'Crescent Park', city:'New Orleans', state:'LA',
    date:'July 4, 2026', time:'9:00 PM',
    lat:29.9511, lng:-90.0715, type:'Fireworks Show',
    desc:'Fireworks over the Mississippi River with jazz music along the levee.',
    website:'https://neworleans.com' },
  { id:'a250_015', name:'Phoenix Desert Fireworks Spectacular',
    org:'City of Phoenix', city:'Phoenix', state:'AZ',
    date:'July 4, 2026', time:'9:00 PM',
    lat:33.4484, lng:-112.0740, type:'Fireworks Show',
    desc:'One of the Southwest\'s largest July 4th fireworks displays.',
    website:'https://phoenix.gov' },
  { id:'a250_016', name:'Portland Waterfront Blues Festival',
    org:'Oregon Food Bank', city:'Portland', state:'OR',
    date:'July 4, 2026', time:'5:00 PM',
    lat:45.5231, lng:-122.6765, type:'Concert',
    desc:'Blues music festival on the Willamette River waterfront with July 4th fireworks.',
    website:'https://waterfrontbluesfest.com' },
  { id:'a250_017', name:'Minneapolis Aquatennial Fireworks',
    org:'Minneapolis Aquatennial', city:'Minneapolis', state:'MN',
    date:'July 4, 2026', time:'10:00 PM',
    lat:44.9778, lng:-93.2650, type:'Fireworks Show',
    desc:'Fireworks over the Mississippi River in downtown Minneapolis.',
    website:'https://aquatennial.com' },
  { id:'a250_018', name:'Miami July 4th on the Bay',
    org:'City of Miami', city:'Miami', state:'FL',
    date:'July 4, 2026', time:'9:00 PM',
    lat:25.7617, lng:-80.1918, type:'Fireworks Show',
    desc:'Fireworks over Biscayne Bay with viewing from Bayfront Park.',
    website:'https://miami.gov' },
  { id:'a250_019', name:'America 250 Sail — Tall Ships',
    org:'America 250 Foundation', city:'Baltimore', state:'MD',
    date:'July 4, 2026', time:'10:00 AM',
    lat:39.2904, lng:-76.6122, type:'America 250',
    desc:'Historic tall ships parade through Baltimore Harbor as part of the official America 250 celebration.',
    website:'https://america250.org' },
  { id:'a250_020', name:'Mount Rushmore Lighting Ceremony',
    org:'National Park Service', city:'Keystone', state:'SD',
    date:'July 4, 2026', time:'9:00 PM',
    lat:43.8791, lng:-103.4591, type:'America 250',
    desc:'Special America 250 lighting ceremony at Mount Rushmore with fireworks.',
    website:'https://nps.gov/moru' }
];

// GET /a250-events — returns seed list + Firestore approved events
app.get('/a250-events', async (req, res) => {
  let events = [...A250_SEED_EVENTS];
  // Merge Firestore approved events
  if(_fbDb){
    try {
      const snap = await _fbDb.collection('approvedEvents').get();
      snap.forEach(function(doc){
        const ev = doc.data();
        if(ev.lat && ev.lng){
          // Avoid duplicates
          const exists = events.some(function(e){ return e.name === ev.name; });
          if(!exists) events.push({
            id:    doc.id,
            name:  ev.name   || '',
            org:   ev.org    || '',
            city:  ev.city   || '',
            state: ev.state  || '',
            date:  ev.date   || 'July 4, 2026',
            time:  ev.time   || '',
            lat:   parseFloat(ev.lat),
            lng:   parseFloat(ev.lng),
            type:  ev.type   || 'Community Event',
            desc:  ev.desc   || '',
            website: ev.website || ''
          });
        }
      });
    } catch(e){ console.warn('a250-events Firestore err:', e.message); }
  }
  res.json({ events, count: events.length, source: 'SpangledAI' });
});

// GET /search-events?q=city+state — proxy to Eventbrite (needs EVENTBRITE_KEY env var)
app.get('/search-events', async (req, res) => {
  const query = req.query.q || '';
  const key   = process.env.EVENTBRITE_KEY || '';
  if(!key){
    return res.json({ events:[], message:'Set EVENTBRITE_KEY in Railway Variables for live search.' });
  }
  try {
    const url = 'https://www.eventbriteapi.com/v3/events/search/'
      + '?q='+encodeURIComponent(query+' July 4 2026')
      + '&token='+key
      + '&expand=venue&location.address='+encodeURIComponent(query);
    const r = await fetch(url);
    const d = await r.json();
    const events = (d.events||[]).map(function(ev){
      const venue = ev.venue || {};
      const addr  = venue.address || {};
      return {
        id:    'eb_'+ev.id,
        name:  ev.name && ev.name.text || '',
        city:  addr.city   || '',
        state: addr.region || '',
        date:  ev.start && ev.start.local ? ev.start.local.split('T')[0] : '',
        time:  ev.start && ev.start.local ? ev.start.local.split('T')[1]||'' : '',
        lat:   parseFloat(venue.latitude)  || null,
        lng:   parseFloat(venue.longitude) || null,
        type:  'Community Event',
        desc:  ev.description && ev.description.text || '',
        website: ev.url || ''
      };
    }).filter(function(e){ return e.lat && e.lng; });
    res.json({ events, count: events.length, source:'Eventbrite' });
  } catch(e){
    res.status(500).json({ error: e.message });
  }
});


// GET /ticketmaster-events?city=Salt+Lake+City&state=UT
// Requires TICKETMASTER_KEY in Railway Variables
// Get free key at: developer.ticketmaster.com (instant, no approval)
app.get('/ticketmaster-events', async (req, res) => {
  const city  = req.query.city  || '';
  const state = req.query.state || '';
  const key   = process.env.TICKETMASTER_KEY || '';
  if(!key){
    return res.json({ events:[], message:'Set TICKETMASTER_KEY in Railway Variables. Get free key at developer.ticketmaster.com' });
  }
  try {
    const params = new URLSearchParams({
      apikey:          key,
      keyword:         'July 4 fireworks independence',
      city:            city,
      stateCode:       state,
      countryCode:     'US',
      startDateTime:   '2026-07-01T00:00:00Z',
      endDateTime:     '2026-07-05T23:59:59Z',
      classificationName: 'Festival',
      size:            '20'
    });
    const r = await fetch('https://app.ticketmaster.com/discovery/v2/events.json?'+params);
    const d = await r.json();
    const items = (d._embedded && d._embedded.events) || [];
    const events = items.map(function(ev){
      const venue = ev._embedded && ev._embedded.venues && ev._embedded.venues[0] || {};
      const loc   = venue.location || {};
      return {
        id:      'tm_'+ev.id,
        name:    ev.name || '',
        city:    venue.city && venue.city.name || city,
        state:   venue.state && venue.state.stateCode || state,
        date:    ev.dates && ev.dates.start && ev.dates.start.localDate || 'July 4, 2026',
        time:    ev.dates && ev.dates.start && ev.dates.start.localTime || '',
        lat:     parseFloat(loc.latitude)  || null,
        lng:     parseFloat(loc.longitude) || null,
        type:    'Community Event',
        desc:    ev.info || ev.pleaseNote || '',
        website: ev.url || '',
        source:  'Ticketmaster'
      };
    }).filter(function(e){ return e.lat && e.lng; });
    res.json({ events, count: events.length, source:'Ticketmaster' });
  } catch(e){
    res.status(500).json({ error: e.message });
  }
});

// GET /local-events?state=UT — scrapes state America 250 pages
// Supported: utah, texas, california, florida, new-york
app.get('/local-events', async (req, res) => {
  const state = (req.query.state||'').toLowerCase().replace(/\s+/g,'-');
  const stateUrls = {
    'ut': 'https://america250.utah.gov/celebrate/',
    'utah': 'https://america250.utah.gov/celebrate/',
    'tx': 'https://texas250.org/events/',
    'fl': 'https://florida250.com/events',
    'ca': 'https://california250.org/events',
    'ny': 'https://america250ny.org/events'
  };
  const url = stateUrls[state];
  if(!url){
    return res.json({
      events:[],
      message:'State page not indexed yet. Supported: UT, TX, FL, CA, NY',
      tip:'Submit events manually via the Admin → Manual Add for other states'
    });
  }
  try {
    const r = await fetch(url, {
      headers:{'User-Agent':'SpangledAI/1.0 (patriotic event aggregator)'}
    });
    const html = await r.text();
    // Extract event data from common HTML patterns
    // Most state pages use structured event listings
    const events = [];
    // Match common event title patterns
    const titleMatches = html.match(/<h[23][^>]*>([^<]{10,80})<\/h[23]>/gi)||[];
    titleMatches.slice(0,10).forEach(function(m,i){
      const title = m.replace(/<[^>]+>/g,'').trim();
      if(title.length > 5){
        events.push({
          id:     'local_'+state+'_'+i,
          name:   title,
          city:   '',
          state:  state.toUpperCase(),
          date:   'July 4, 2026',
          type:   'America 250',
          source: 'State page',
          note:   'Verify details at '+url
        });
      }
    });
    res.json({ events, count: events.length, source: url,
      note:'Coordinates not available from scrape — admin must verify and add lat/lng via Manual Add' });
  } catch(e){
    res.status(500).json({ error: e.message, url });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// CLAUDE PROXY
// ═════════════════════════════════════════════════════════════════════════════

app.post('/claude', express.json({ limit:'10mb' }), async (req, res) => {
  const { apiKey, model, max_tokens, messages, system } = req.body;
  const key = apiKey || process.env.ANTHROPIC_API_KEY;
  if(!key) return res.status(401).json({ error:{ type:'authentication_error',
    message:'No API key — set ANTHROPIC_API_KEY in Railway env.' }});
  try {
    const payload = {
      model:      model      || 'claude-sonnet-4-6',
      max_tokens: max_tokens || 1000,
      messages:   messages   || []
    };
    if(system) payload.system = system;
    const r = await fetch('https://api.anthropic.com/v1/messages',{
      method:'POST',
      headers:{ 'Content-Type':'application/json',
                'x-api-key': key, 'anthropic-version':'2023-06-01' },
      body: JSON.stringify(payload)
    });
    res.json(await r.json());
  } catch(e){ res.status(500).json({ error:{ type:'server_error', message:e.message }}); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('SpangledAI backend on port', PORT));
