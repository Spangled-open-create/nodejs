const express = require('express');
const stripe  = require('stripe')(process.env.STRIPE_SECRET_KEY || '');
const app     = express();

// ── CORS — allow browser requests from any origin ──────────────────────────
app.use(function(req, res, next){
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if(req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ── HEALTH CHECK ────────────────────────────────────────────────────────────
app.get('/', express.json(), (req, res) => {
  res.json({ status: 'SpangledAI backend running', timestamp: new Date() });
});

// ── CLAUDE PROXY ────────────────────────────────────────────────────────────
// Receives { apiKey, model, max_tokens, messages, system? } from browser
// Forwards to Anthropic API (no CORS restriction server-side)
app.post('/claude', express.json({ limit: '10mb' }), async (req, res) => {
  const { apiKey, model, max_tokens, messages, system } = req.body;

  // Use key from request body, or fall back to env var
  const key = apiKey || process.env.ANTHROPIC_API_KEY;
  if(!key){
    return res.status(401).json({ error: { type:'authentication_error',
      message:'No API key. Set ANTHROPIC_API_KEY in Railway env or pass apiKey in request body.' }});
  }

  try {
    const payload = {
      model: model || 'claude-sonnet-4-20250514',
      max_tokens: max_tokens || 1000,
      messages: messages || []
    };
    if(system) payload.system = system;

    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
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

// ── STRIPE WEBHOOK ──────────────────────────────────────────────────────────
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET || '');
  } catch(err) {
    return res.status(400).send('Webhook Error: ' + err.message);
  }
  switch(event.type) {
    case 'payment_intent.succeeded':
    case 'checkout.session.completed':
      console.log('Payment success:', event.data.object.id);
      // TODO: set sai_premium=true for user in Firebase
      break;
  }
  res.json({ received: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('SpangledAI backend running on port', PORT));
