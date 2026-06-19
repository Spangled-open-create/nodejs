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
let _memPassword   = '';
let eventQueue     = [];
let approvedEvents = [];
let teamMembers    = [];

// ── HELPERS: read/write password via Firestore with memory fallback ───────────
async function getAdminPassword(){
  if(_fbDb){
    try {
      const doc = await _fbDb.collection('config').doc('adminAuth').get();
      if(doc.exists && doc.data().password) return doc.data().password;
    } catch(e){ console.warn('getAdminPassword Firestore err:', e.message); }
  }
  return _memPassword; // fallback
}

async function setAdminPassword(password){
  _memPassword = password; // always set memory
  if(_fbDb){
    try {
      await _fbDb.collection('config').doc('adminAuth').set({
        password,
        updatedAt: _fbAdmin.firestore.FieldValue.serverTimestamp()
      });
      return true;
    } catch(e){ console.warn('setAdminPassword Firestore err:', e.message); }
  }
  return false; // memory only
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
  if(!stored)
    return res.json({ ok:false, message:'⚠️ No password set. Open Ops Center → Access Codes → save Events Admin code.' });
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
app.listen(PORT, () => console.log('SpangledAI backend on port', PORT));      const doc = await _fbDb.collection('config').doc('adminAuth').get();
      if(doc.exists && doc.data().password) return doc.data().password;
    } catch(e){ console.warn('getAdminPassword Firestore err:', e.message); }
  }
  return _memPassword; // fallback
}

async function setAdminPassword(password){
  _memPassword = password; // always set memory
  if(_fbDb){
    try {
      await _fbDb.collection('config').doc('adminAuth').set({
        password,
        updatedAt: _fbAdmin.firestore.FieldValue.serverTimestamp()
      });
      return true;
    } catch(e){ console.warn('setAdminPassword Firestore err:', e.message); }
  }
  return false; // memory only
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
  if(!stored)
    return res.json({ ok:false, message:'⚠️ No password set. Open Ops Center → Access Codes → save Events Admin code.' });
  res.json({ ok: password === stored, message: '✗ Incorrect password.' });
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
