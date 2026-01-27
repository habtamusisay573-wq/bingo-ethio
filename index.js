const admin = require('firebase-admin');
const express = require('express');
const https = require('https');
const app = express();

app.use(express.json());

// 1. Firebase Config
const serviceAccount = {
  projectId: process.env.PROJECT_ID,
  clientEmail: process.env.CLIENT_EMAIL,
  privateKey: process.env.PRIVATE_KEY ? process.env.PRIVATE_KEY.replace(/\\n/g, '\n') : "",
};

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: "https://dagi-bingo-default-rtdb.firebaseio.com"
  });
}

const db = admin.database();
const ADMIN_ID = "8431270634";

// 2. ጌም ኢንጂን (The Logic Controller)
const Game = {
    timer: null,
    drawer: null,
    
    // ታይመሩን ለማስጀመር
    startTimer: function(seconds) {
        this.stopAll();
        db.ref('game/isTimerRunning').set(true);
        
        this.timer = setInterval(async () => {
            seconds--;
            await db.ref('game/timer').set(seconds);
            
            if (seconds <= 0) {
                this.stopAll();
                await db.ref('game').update({ status: 'active', isTimerRunning: false, timer: 0 });
                this.startDrawing();
            }
        }, 1000);
    },

    // ቁጥር ማውጣት ለመጀመር
    startDrawing: function() {
        let drawn = [];
        this.drawer = setInterval(async () => {
            const snap = await db.ref('game').get();
            const data = snap.val();

            if (!data || data.winner || data.status !== 'active') return this.stopAll();

            drawn = data.drawn || [];
            if (drawn.length >= 75) return this.stopAll();

            let num;
            do { num = Math.floor(Math.random() * 75) + 1; } while (drawn.includes(num));
            
            drawn.push(num);
            await db.ref('game/drawn').set(drawn);
        }, 2000); // 3 ሰከንድ ለመረጋጋት
    },

    // ሁሉንም ማቆሚያ
    stopAll: function() {
        if (this.timer) clearInterval(this.timer);
        if (this.drawer) clearInterval(this.drawer);
        this.timer = null;
        this.drawer = null;
    }
};

// 3. Firebase Listeners (Real-time Events)
db.ref('game/status').on('value', snap => {
    if (snap.val() === 'waiting') Game.startTimer(30);
});

db.ref('game/winner').on('value', async snap => {
    const win = snap.val();
    if (win && !win.processed) {
        Game.stopAll();
        // 80/20 Payout Logic
        const bet = (await db.ref('game/currentBetPrice').get()).val() || 0;
        const boards = (await db.ref('reserved_boards').get()).numChildren();
        const pool = boards * bet;

        await db.ref(`users/${win.id}/bal`).transaction(c => (c || 0) + (pool * 0.8));
        await db.ref(`users/${ADMIN_ID}/bal`).transaction(c => (c || 0) + (pool * 0.2));
        await db.ref('game/winner/processed').set(true);

        setTimeout(async () => {
            await db.ref('reserved_boards').remove();
            await db.ref('game').set({ drawn: [], status: 'idle', winner: null, timer: -1 });
        }, 5000);
    }
});

// 4. API Endpoints (Webhook & Others)
app.post('/sms-webhook', async (req, res) => {
    const { text, message } = req.body;
    const msg = text || message || "";
    const txMatch = msg.match(/[A-Z0-9]{10,12}/i);
    const amtMatch = msg.match(/(\d+(?:\.\d+)?)\s?(?:ETB|ብር)/i);
    const phMatch = msg.match(/(?:\+251|0)(9\d{8}|7\d{8})/);

    if (txMatch && amtMatch && phMatch) {
        const txId = txMatch[0].toUpperCase();
        const amount = parseFloat(amtMatch[1]);
        const phone = '0' + phMatch[1];

        try {
            const userSnap = await db.ref('users').orderByChild('phone').equalTo(phone).once('value');
            if (userSnap.exists()) {
                const uid = Object.keys(userSnap.val())[0];
                await db.ref(`users/${uid}/bal`).transaction(c => (c || 0) + amount);
                await db.ref(`used_transactions/${txId}`).set({ uid, amount, date: new Date().toISOString() });
            }
        } catch (e) { console.error("Webhook Error"); }
    }
    res.sendStatus(200);
});

// Health Check & Port
app.get('/', (req, res) => res.send("Dagi Pro-Bingo Engine Online 🟢"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on ${PORT}`));

// Keep-Alive Ping
setInterval(() => {
    const host = process.env.RENDER_EXTERNAL_HOSTNAME;
    if (host) https.get(`https://${host}/`, () => {});
}, 10 * 60 * 1000);
