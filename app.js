const express = require('express');
const stripe  = require('stripe')(process.env.STRIPE_SECRET_KEY || '');
const app     = express();

// ── IN-MEMORY STORE ─────────────────────────────────────────────────────────
// Replace with Firebase/Postgres for true persistence across restarts
let eventQueue    = [];   // pending user submissions awaiting admin approval
let approvedEvents = [];  // admin-approved events served to all users
let teamMembers   = [];   // curator/staff accounts

// ── CORS ─────────────────────────────────────────────────────────────────────
app.use(function(req, res, next){
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,x-admin-key');
  if(req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ── ADMIN AUTH MIDDLEWARE ─────────────────────────────────────────────────────
// Lightweight key check — pass ADMIN_SECRET in Railway env vars
function requireAdmin(req, res, next){
  const key = req.headers['x-admin-key'] || req.body?.adminKey || '';
  const secret = process.env.ADMIN_SECRET || '';
  if(!secret){ return next(); } // no secret set → open (dev mode)
  if(key !== secret){ return res.status(401).json({ error:'Unauthorized' }); }
  next();
}

// ── HEALTH CHECK ─────────────────────────────────────────────────────────────
app.get('/', express.json(), (req, res) => {
  res.json({
    status: 'SpangledAI backend running',
    timestamp: new Date(),
    queueLength: eventQueue.length,
    approvedCount: approvedEvents.length,
    teamCount: teamMembers.length
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// EVENTS — PUBLIC
// ═════════════════════════════════════════════════════════════════════════════

// GET /events — fetch all approved events (used by app on load)
app.get('/events', (req, res) => {
  res.json({ events: approvedEvents, count: approvedEvents.length });
});

// POST /submit-event — user submits a new event from Pyro Portal
app.post('/submit-event', express.json({ limit: '2mb' }), (req, res) => {
  const { name, org, loc, city, state, date, time, website, desc, type } = req.body;
  if(!name || !city || !state){
    return res.status(400).json({ error: 'name, city, and state are required' });
  }
  const item = {
    id: 'q_' + Date.now() + '_' + Math.random().toString(36).slice(2,7),
    name, org, loc, city, state,
    date:    date    || 'July 4, 2026',
    time:    time    || '',
    website: website || '',
    desc:    desc    || '',
    type:    type    || 'Community Event',
    lat:     parseFloat(req.body.lat) || null,
    lng:     parseFloat(req.body.lng) || null,
    _source:    'Pyro Portal',
    _submitted: new Date().toISOString()
  };
  eventQueue.push(item);
  console.log('New submission:', item.name, 'from', item.city, item.state);
  res.json({ ok: true, id: item.id, message: 'Submission received — pending admin review.' });
});

// ═════════════════════════════════════════════════════════════════════════════
// EVENTS — ADMIN
// ═════════════════════════════════════════════════════════════════════════════

// GET /admin/queue — fetch pending event queue
app.get('/admin/queue', express.json(), requireAdmin, (req, res) => {
  res.json({ queue: eventQueue, count: eventQueue.length });
});

// POST /admin/approve/:id — approve a queued event
app.post('/admin/approve/:id', express.json(), requireAdmin, (req, res) => {
  const idx = eventQueue.findIndex(e => e.id === req.params.id);
  if(idx < 0) return res.status(404).json({ error: 'Event not found in queue' });
  const ev = eventQueue.splice(idx, 1)[0];
  ev._approved   = new Date().toISOString();
  ev._approvedBy = req.body?.approvedBy || 'admin';
  approvedEvents.push(ev);
  console.log('APPROVED:', ev.name, 'by', ev._approvedBy);
  res.json({ ok: true, event: ev, approvedCount: approvedEvents.length });
});

// POST /admin/reject/:id — reject and remove from queue
app.post('/admin/reject/:id', express.json(), requireAdmin, (req, res) => {
  const idx = eventQueue.findIndex(e => e.id === req.params.id);
  if(idx < 0) return res.status(404).json({ error: 'Event not found in queue' });
  const ev = eventQueue.splice(idx, 1)[0];
  console.log('REJECTED:', ev.name);
  res.json({ ok: true, removed: ev.name });
});

// DELETE /admin/event/:id — remove an approved event
app.delete('/admin/event/:id', express.json(), requireAdmin, (req, res) => {
  const idx = approvedEvents.findIndex(e => e.id === req.params.id);
  if(idx < 0) return res.status(404).json({ error: 'Approved event not found' });
  const ev = approvedEvents.splice(idx, 1)[0];
  console.log('REMOVED approved event:', ev.name);
  res.json({ ok: true, removed: ev.name });
});

// POST /admin/add-event — admin manually adds a pre-approved event
app.post('/admin/add-event', express.json({ limit: '2mb' }), requireAdmin, (req, res) => {
  const { name, city, state } = req.body;
  if(!name || !city || !state){
    return res.status(400).json({ error: 'name, city, state required' });
  }
  const ev = {
    id: 'adm_' + Date.now(),
    ...req.body,
    _source:   'Admin Manual Add',
    _approved: new Date().toISOString(),
    _approvedBy: req.body.approvedBy || 'admin'
  };
  approvedEvents.push(ev);
  console.log('ADMIN ADDED:', ev.name);
  res.json({ ok: true, event: ev });
});

// ═════════════════════════════════════════════════════════════════════════════
// TEAM / CURATOR PERMISSIONS
// ═════════════════════════════════════════════════════════════════════════════

// GET /admin/team — list all team members
app.get('/admin/team', express.json(), requireAdmin, (req, res) => {
  res.json({ team: teamMembers, count: teamMembers.length });
});

// POST /admin/team — add or update a team member
app.post('/admin/team', express.json(), requireAdmin, (req, res) => {
  const { name, email, role, permissions } = req.body;
  if(!name || !email){
    return res.status(400).json({ error: 'name and email required' });
  }
  const existing = teamMembers.findIndex(m => m.email === email);
  const member = {
    id:          existing >= 0 ? teamMembers[existing].id : 'mbr_' + Date.now(),
    name,
    email,
    role:        role        || 'Curator',
    permissions: permissions || {
      viewQueue:      true,
      approveEvents:  false,
      rejectEvents:   false,
      manualAdd:      false,
      viewAnalytics:  false,
      manageTeam:     false
    },
    _added:   existing >= 0 ? teamMembers[existing]._added : new Date().toISOString(),
    _updated: new Date().toISOString()
  };
  if(existing >= 0){
    teamMembers[existing] = member;
    res.json({ ok: true, action: 'updated', member });
  } else {
    teamMembers.push(member);
    res.json({ ok: true, action: 'added', member });
  }
});

// DELETE /admin/team/:id — remove a team member
app.delete('/admin/team/:id', express.json(), requireAdmin, (req, res) => {
  const idx = teamMembers.findIndex(m => m.id === req.params.id);
  if(idx < 0) return res.status(404).json({ error: 'Member not found' });
  const m = teamMembers.splice(idx, 1)[0];
  res.json({ ok: true, removed: m.name });
});

// ═════════════════════════════════════════════════════════════════════════════
// CLAUDE PROXY
// ═════════════════════════════════════════════════════════════════════════════
app.post('/claude', express.json({ limit: '10mb' }), async (req, res) => {
  const { apiKey, model, max_tokens, messages, system } = req.body;
  const key = apiKey || process.env.ANTHROPIC_API_KEY;
  if(!key){
    return res.status(401).json({ error: { type:'authentication_error',
      message:'No API key — set ANTHROPIC_API_KEY in Railway env or pass apiKey in body.' }});
  }
  try {
    const payload = {
      model:      model      || 'claude-sonnet-4-6',
      max_tokens: max_tokens || 1000,
      messages:   messages   || []
    };
    if(system) payload.system = system;
    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         key,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(payload)
    });
    const data = await anthropicRes.json();
    res.json(data);
  } catch(err) {
    res.status(500).json({ error: { type:'server_error', message: err.message }});
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// STRIPE WEBHOOK
// ═════════════════════════════════════════════════════════════════════════════
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET || '');
  } catch(err) {
    return res.status(400).send('Webhook Error: ' + err.message);
  }
  switch(event.type){
    case 'checkout.session.completed':
    case 'payment_intent.succeeded':
      console.log('Payment success:', event.data.object.id);
      // TODO: write sai_premium=true to Firebase for the user
      break;
  }
  res.json({ received: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('SpangledAI backend running on port', PORT));
