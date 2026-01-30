const admin = require('firebase-admin');
const express = require('express');
const https = require('https');
const app = express();

app.use(express.json());

// 1. Firebase Config
const serviceAccount = {
  projectId: process.env.PROJECT_ID,
  clientEmail: process.env.CLIENT_EMAIL,
  privateKey: process.env.PRIVATE_KEY
    ? process.env.PRIVATE_KEY.replace(/\\n/g, '\n')
    : "",
};

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: "https://dagi-bingo-default-rtdb.firebaseio.com"
  });
}

const db = admin.database();
const ADMIN_ID = "8431270634";

// 2. GAME ENGINE
const Game = {
  timer: null,
  drawer: null,

  startTimer(seconds) {
    this.stopAll();
    db.ref('game/isTimerRunning').set(true);

    this.timer = setInterval(async () => {
      seconds--;
      await db.ref('game/timer').set(seconds);

      if (seconds <= 0) {
        this.stopAll();
        await db.ref('game').update({
          status: 'active',
          isTimerRunning: false,
          timer: 0
        });
        this.startDrawing();
      }
    }, 1000);
  },

  startDrawing() {
    this.drawer = setInterval(async () => {
      const snap = await db.ref('game').get();
      const data = snap.val();

      if (!data || data.winner || data.status !== 'active') {
        return this.stopAll();
      }

      const drawn = data.drawn || [];
      if (drawn.length >= 75) return this.stopAll();

      let num;
      do {
        num = Math.floor(Math.random() * 75) + 1;
      } while (drawn.includes(num));

      drawn.push(num);
      await db.ref('game/drawn').set(drawn);
    }, 2000);
  },

  stopAll() {
    if (this.timer) clearInterval(this.timer);
    if (this.drawer) clearInterval(this.drawer);
    this.timer = null;
    this.drawer = null;
  },

  checkAutoReset() {
    setInterval(async () => {
      try {
        const gameSnap = await db.ref('game').get();
        const game = gameSnap.val() || {};
        const playersSnap = await db.ref('online_players').get();
        const boardsSnap = await db.ref('reserved_boards').get();

        if (game.status === 'active' && !playersSnap.exists()) {
          console.log("No players → Auto Reset");
          this.forceReset();
        }

        else if (
          game.status === 'waiting' &&
          game.timer <= 0 &&
          !boardsSnap.exists()
        ) {
          console.log("No boards → Auto Reset");
          this.forceReset();
        }
      } catch (e) {
        console.error("AutoReset Error:", e);
      }
    }, 3000);
  },

  async forceReset() {
    this.stopAll();
    await db.ref('reserved_boards').remove();
    await db.ref('game').update({
      drawn: [],
      status: 'idle',
      winner: null,
      timer: -1,
      jackpot: 0,
      isTimerRunning: false
    });
    console.log("Game Reset Done 🧹");
  }
};

// Start watchdog
Game.checkAutoReset();

// 3. REALTIME LISTENERS
db.ref('game/status').on('value', snap => {
  if (snap.val() === 'waiting') {
    Game.startTimer(30);
  }
});

db.ref('game/winner').on('value', async snap => {
  const win = snap.val();
  if (!win || win.processed) return;

  Game.stopAll();

  // ✅ FIXED JACKPOT CALCULATION
  const boardsSnap = await db.ref('reserved_boards').get();
  let pool = 0;

  if (boardsSnap.exists()) {
    boardsSnap.forEach(child => {
      const data = child.val();
      const boards = data.boards || 0;
      const price = data.price || 0;
      pool += boards * price;
    });
  }

  if (pool > 0) {
    const winnerPrize = pool * 0.8;
    const adminShare = pool * 0.2;

    await db.ref(`users/${win.id}/bal`)
      .transaction(b => (b || 0) + winnerPrize);

    await db.ref(`users/${ADMIN_ID}/bal`)
      .transaction(b => (b || 0) + adminShare);

    await db.ref(`history/${win.id}`).push({
      type: "ቢንጎ አሸናፊ 🏆",
      amt: winnerPrize,
      mode: "PLUS",
      date: new Date().toLocaleString('am-ET')
    });
  }

  await db.ref('game/winner/processed').set(true);

  setTimeout(() => Game.forceReset(), 5000);
});

// 4. SMS WEBHOOK
app.post('/sms-webhook', async (req, res) => {
  const { text, message } = req.body;
  const msg = text || message || "";

  const txMatch = msg.match(/[A-Z0-9]{10,12}/i);
  const amtMatch = msg.match(/(\d+(?:\.\d+)?)\s?(ETB|ብር)/i);
  const phMatch = msg.match(/(?:\+251|0)(9\d{8}|7\d{8})/);

  if (!txMatch || !amtMatch || !phMatch) {
    return res.sendStatus(200);
  }

  const txId = txMatch[0].toUpperCase();
  const amount = parseFloat(amtMatch[1]);
  const phone = '0' + phMatch[1];

  try {
    // ✅ PREVENT DOUBLE TX
    const usedSnap = await db.ref(`used_transactions/${txId}`).get();
    if (usedSnap.exists()) return res.sendStatus(200);

    const userSnap = await db.ref('users')
      .orderByChild('phone')
      .equalTo(phone)
      .once('value');

    if (!userSnap.exists()) return res.sendStatus(200);

    const uid = Object.keys(userSnap.val())[0];

    await db.ref(`users/${uid}/bal`)
      .transaction(b => (b || 0) + amount);

    await db.ref(`history/${uid}`).push({
      type: "በቴሌብር ገቢ ✅",
      amt: amount,
      mode: "PLUS",
      date: new Date().toLocaleString('am-ET')
    });

    await db.ref(`used_transactions/${txId}`).set({
      uid,
      amount,
      date: new Date().toISOString()
    });

  } catch (e) {
    console.error("Webhook Error:", e);
  }

  res.sendStatus(200);
});

// HEALTH CHECK
app.get('/', (req, res) =>
  res.send("Dagi Pro Bingo Engine Online 🟢")
);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`Server running on ${PORT}`)
);

// KEEP ALIVE
setInterval(() => {
  const host = process.env.RENDER_EXTERNAL_HOSTNAME;
  if (host) https.get(`https://${host}/`);
}, 5 * 60 * 1000);
