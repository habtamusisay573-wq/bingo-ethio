// ===============================
// FULL SERVER FILE (FIXED + COMPLETE)
// ===============================
const admin = require('firebase-admin');
const express = require('express');
const https = require('https');
const app = express();

app.use(express.json());

// ===============================
// 1. FIREBASE CONFIG
// ===============================
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

// ===============================
// 2. GAME ENGINE
// ===============================
const Game = {
  timer: null,
  drawer: null,

  async startTimer(seconds) {
    if (this.timer) return; // ቲመሩ አስቀድሞ እየሰራ ከሆነ በድጋሚ እንዳይጀምር

    await db.ref('game').update({
      status: 'waiting',
      isTimerRunning: true,
      timer: seconds,
      drawn: []
    });

    console.log("⏳ የመጀመሪያው ተጫዋች ገብቷል - ቲመር ተጀምሯል...");

    this.timer = setInterval(async () => {
      seconds--;
      await db.ref('game/timer').set(seconds);

      if (seconds <= 0) {
        clearInterval(this.timer);
        this.timer = null;

        const boardsSnap = await db.ref('reserved_boards').get();
        if (boardsSnap.exists()) {
          await db.ref('game').update({
            status: 'active',
            isTimerRunning: false,
            timer: 0,
            lastDrawTime: Date.now()
          });
          this.startDrawing();
        } else {
          console.log("♻️ No boards bought. Resetting...");
          this.forceReset();
        }
      }
    }, 1000);
  },

  startDrawing() {
    if (this.drawer) return;

    this.drawer = setInterval(async () => {
      const snap = await db.ref('game').get();
      const data = snap.val();

      // ተጫዋች መኖሩን እና ጨዋታው መቀጠሉን ማረጋገጫ
      const onlineSnap = await db.ref('online_players').get();
      const onlineCount = onlineSnap.exists() ? Object.keys(onlineSnap.val()).length : 0;

      if (onlineCount === 0 || !data || data.winner || data.status !== 'active') {
        console.log("🛑 ተጫዋች ስለሌለ ወይም ጨዋታው ስላለቀ ቁጥር መጥራት ቆሟል");
        return this.stopAll();
      }

      const drawn = data.drawn || [];
      if (drawn.length >= 75) return this.stopAll();

      let num;
      do {
        num = Math.floor(Math.random() * 75) + 1;
      } while (drawn.includes(num));

      drawn.push(num);

      await db.ref('game').update({
        drawn,
        lastDrawTime: Date.now()
      });
    }, 3000); // ቁጥር መጥሪያ ፍጥነት (3 ሰከንድ)
  },

  stopAll() {
    if (this.timer) clearInterval(this.timer);
    if (this.drawer) clearInterval(this.drawer);
    this.timer = null;
    this.drawer = null;
  },

  async forceReset() {
    this.stopAll();
    await db.ref('reserved_boards').remove();
    await db.ref('game/winner_lock').remove();
    await db.ref('game').set({
      drawn: [],
      status: 'idle',
      winner: null,
      timer: -1,
      jackpot: 0,
      isTimerRunning: false,
      lastPlayerLeftAt: null,
      lastDrawTime: null,
      activeGameId: Date.now()
    });
    console.log("🧹 ጨዋታው ወደ መጀመሪያው ተመልሷል (Reset)");
  },

  // AUTO RESET WATCHDOG (FIXED)
  checkAutoReset() {
    const GRACE_TIME = 10000; // 10 ሰከንድ

    setInterval(async () => {
      try {
        const gameSnap = await db.ref('game').get();
        const game = gameSnap.val() || {};

        const playersSnap = await db.ref('online_players').get();
        const onlineCount = playersSnap.exists() ? Object.keys(playersSnap.val()).length : 0;

        const boardsSnap = await db.ref('reserved_boards').get();
        const boardCount = boardsSnap.exists() ? Object.keys(boardsSnap.val()).length : 0;

        const now = Date.now();

        // 1️⃣ waiting + no boards
        if (game.status === 'waiting' && game.timer <= 0 && boardCount === 0) {
          console.log("♻️ Auto reset (waiting + no boards)");
          return this.forceReset();
        }

        // 2️⃣ active + no online players
        if (game.status === 'active' && onlineCount === 0) {
          if (!game.lastPlayerLeftAt) {
            await db.ref('game/lastPlayerLeftAt').set(now);
            return;
          }
          if (now - game.lastPlayerLeftAt >= GRACE_TIME) {
            console.log("♻️ Auto reset (no players 10s)");
            return this.forceReset();
          }
          return;
        }

        // 3️⃣ players came back
        if (onlineCount > 0 && game.lastPlayerLeftAt) {
          await db.ref('game/lastPlayerLeftAt').remove();
        }

        // 4️⃣ stalled game (drawer stopped)
        if (game.status === 'active' && game.lastDrawTime && now - game.lastDrawTime > 20000) {
          console.log("♻️ Auto reset (stalled game)");
          return this.forceReset();
        }

      } catch (e) {
        console.error("AutoReset Error:", e);
      }
    }, 5000);
  }
};

// start watchdog
Game.checkAutoReset();

// ===============================
// 3. REALTIME LISTENERS
// ===============================

// የመጀመሪያው ሰው ቦርድ ሲገዛ ብቻ ቲመር እንዲጀምር የሚያደርግ
db.ref('reserved_boards').on('value', async snap => {
  const count = snap.numChildren();
  const gameSnap = await db.ref('game').get();
  const game = gameSnap.val() || {};

  // ጨዋታው ዝግጁ (idle) ሆኖ ሳለ ቢያንስ 1 ሰው ካርቴላ ሲገዛ
  if (count === 1 && (game.status === 'idle' || !game.status)) {
    Game.startTimer(30);
  }
});

// ===============================
// 4. WINNER LISTENER (RACE SAFE)
// ===============================
db.ref('game/winner').on('value', async snap => {
  const win = snap.val();
  if (!win || win.processed) return;

  const lockRef = db.ref('game/winner_lock');
  const lock = await lockRef.transaction(v => v || Date.now());
  if (!lock.committed) return;

  Game.stopAll();

  const boardsSnap = await db.ref('reserved_boards').get();
  let totalPool = 0;

  if (boardsSnap.exists()) {
    boardsSnap.forEach(c => {
      totalPool += Number(c.val().betAmount || 0);
    });
  }

  if (totalPool > 0) {
    const winnerPrize = Math.floor(totalPool * 0.8);
    const adminShare = totalPool - winnerPrize;
    const dateStr = new Date().toLocaleString('am-ET');

    await db.ref(`users/${win.id}/bal`).transaction(b => (b || 0) + winnerPrize);
    await db.ref(`users/${ADMIN_ID}/bal`).transaction(b => (b || 0) + adminShare);

    await db.ref(`history/${win.id}`).push({
      type: "ቢንጎ አሸናፊ 🏆",
      amt: winnerPrize,
      mode: "PLUS",
      date: dateStr
    });

    await db.ref(`history/${ADMIN_ID}`).push({
      type: "የቤት ኮሚሽን (20%)",
      amt: adminShare,
      mode: "PLUS",
      date: dateStr
    });
  }

  await db.ref('game/winner/processed').set(true);
  setTimeout(() => Game.forceReset(), 8000); // 8 ሰከንድ ቆይቶ Reset ያደርጋል
});

// ===============================
// 5. SMS WEBHOOK (DUPLICATE SAFE)
// ===============================
app.post('/sms-webhook', async (req, res) => {
  const msg = req.body.text || req.body.message || "";

  const txMatch = msg.match(/[A-Z0-9]{10,12}/i);
  const amtMatch = msg.match(/(\d+(?:\.\d+)?)\s?(ETB|ብር)/i);
  const phMatch = msg.match(/(?:\+251|0)(9\d{8}|7\d{8})/);

  if (!txMatch || !amtMatch || !phMatch) return res.sendStatus(200);

  const txId = txMatch[0].toUpperCase();
  const amount = parseFloat(amtMatch[1]);
  const phone = '0' + phMatch[1];

  const usedRef = db.ref(`used_transactions/${txId}`);
  const used = await usedRef.transaction(v => v || {
    phone,
    amount,
    date: Date.now()
  });

  if (!used.committed) return res.sendStatus(200);

  const userSnap = await db.ref('users')
    .orderByChild('phone')
    .equalTo(phone)
    .once('value');

  if (!userSnap.exists()) return res.sendStatus(200);

  const uid = Object.keys(userSnap.val())[0];

  await db.ref(`users/${uid}/bal`).transaction(b => (b || 0) + amount);
  await db.ref(`history/${uid}`).push({
    type: "Telebirr Deposit ✅",
    amt: amount,
    mode: "PLUS",
    date: new Date().toLocaleString('am-ET')
  });

  res.sendStatus(200);
});

// ===============================
// 6. HEALTH CHECK + SERVER
// ===============================
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
