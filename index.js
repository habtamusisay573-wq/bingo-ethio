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

  // ===============================
  // AUTO RESET WATCHDOG (5 SECONDS)
  // ===============================
  checkAutoReset() {
    const GRACE_TIME = 5 * 1000; // ✅ 5 seconds

    setInterval(async () => {
      try {
        const game = (await db.ref('game').get()).val() || {};
        const playersSnap = await db.ref('online_players').get();
        const boardsSnap = await db.ref('reserved_boards').get();

        // 1️⃣ Waiting state + no boards
        if (
          game.status === 'waiting' &&
          game.timer <= 0 &&
          !boardsSnap.exists()
        ) {
          console.log("No boards → Auto Reset");
          return this.forceReset();
        }

        // 2️⃣ Game active but ALL players left
        if (game.status === 'active' && !playersSnap.exists()) {
          const now = Date.now();

          if (!game.lastPlayerLeftAt) {
            await db.ref('game/lastPlayerLeftAt').set(now);
            console.log("All players left → start 5s grace");
            return;
          }

          if (now - game.lastPlayerLeftAt >= GRACE_TIME) {
            console.log("5s passed → Auto Reset");
            await this.forceReset();
          }
          return;
        }

        // 3️⃣ Players came back → cancel reset
        if (playersSnap.exists() && game.lastPlayerLeftAt) {
          await db.ref('game/lastPlayerLeftAt').remove();
          console.log("Players rejoined → cancel auto reset");
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
      isTimerRunning: false,
      lastPlayerLeftAt: null
    });
    console.log("Game Reset Done 🧹");
  }
};

// Start watchdog
Game.checkAutoReset();

// ===============================
// 3. REALTIME LISTENERS
// ===============================
db.ref('game/status').on('value', snap => {
  if (snap.val() === 'waiting') {
    Game.startTimer(30);
  }
});

// ===============================
// 4. WINNER LISTENER (80 / 20)
// ===============================
db.ref('game/winner').on('value', async snap => {
  const win = snap.val();
  if (!win || win.processed) return;

  Game.stopAll();

  const boardsSnap = await db.ref('reserved_boards').get();
  let totalPool = 0;

  if (boardsSnap.exists()) {
    boardsSnap.forEach(child => {
      totalPool += Number(child.val().betAmount || 0);
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
  setTimeout(() => Game.forceReset(), 5000);
});

// ===============================
// 5. HEALTH CHECK + SERVER
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
