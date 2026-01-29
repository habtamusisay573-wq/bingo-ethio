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
        }, 2000);
    },

    stopAll: function() {
        if (this.timer) clearInterval(this.timer);
        if (this.drawer) clearInterval(this.drawer);
        this.timer = null;
        this.drawer = null;
    },

    checkAutoReset: function() {
        setInterval(async () => {
            try {
                const gameSnap = await db.ref('game').get();
                const gameData = gameSnap.val() || {};
                const playersSnap = await db.ref('online_players').get();
                const boardsSnap = await db.ref('reserved_boards').get();

                if (gameData.status === 'active' && !playersSnap.exists()) {
                    this.forceReset();
                }
                else if (gameData.status === 'waiting' && gameData.timer <= 0 && !boardsSnap.exists()) {
                    this.forceReset();
                }
            } catch (e) { console.error("Auto-Reset Check Error:", e); }
        }, 3000);
    },

    forceReset: async function() {
        this.stopAll();
        await db.ref('reserved_boards').remove();
        await db.ref('game').update({
            drawn: [], status: 'idle', winner: null, timer: -1, jackpot: 0, isTimerRunning: false
        });
        console.log("System Cleaned via Force Reset 🧹");
    }
};

Game.checkAutoReset();

db.ref('game/status').on('value', snap => {
    if (snap.val() === 'waiting') Game.startTimer(30);
});

// --- አስተማማኝ የአሸናፊ ክፍያ ስሌት ---
db.ref('game/winner').on('value', async snap => {
    const win = snap.val();
    if (win && !win.processed) {
        Game.stopAll();
        
        // አዲስ የሂሳብ አሰራር፡ እያንዳንዱን ካርቴላ ዋጋ አንድ በአንድ መደምር
        const boardsSnap = await db.ref('reserved_boards').get();
        let totalPool = 0;
        
        boardsSnap.forEach(child => {
            const boardData = child.val();
            // በደፈናው ሳይሆን ተጫዋቹ የከፈለውን ትክክለኛ መጠን ይደምራል
            totalPool += (boardData.betAmount || 0); 
        });

        if (totalPool > 0) {
            const winnerPrize = totalPool * 0.8;
            const adminComm = totalPool * 0.2;

            // 1. ለአሸናፊው መክፈል (ከስጦታ ብር ጋር እንዳይቀላቀል ወደ bal ይገባል)
            await db.ref(`users/${win.id}/bal`).transaction(c => (c || 0) + winnerPrize);
            
            // 2. ለአስተዳዳሪው 20% ኮሚሽን
            await db.ref(`users/${ADMIN_ID}/bal`).transaction(c => (c || 0) + adminComm);

            // 3. ታሪክ መመዝገብ
            await db.ref(`history/${win.id}`).push({
                type: "ቢንጎ አሸናፊ 🏆",
                amt: winnerPrize,
                mode: "PLUS",
                date: new Date().toLocaleString('am-ET'),
                ts: Date.now()
            });
        }

        await db.ref('game/winner/processed').set(true);
        setTimeout(() => Game.forceReset(), 5000);
    }
});

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
                await db.ref(`history/${uid}`).push({
                    type: "በቴሌብር ገቢ ተደርጓል ✅",
                    amt: amount,
                    mode: "PLUS",
                    date: new Date().toLocaleString('am-ET'),
                    ts: Date.now()
                });
                await db.ref(`used_transactions/${txId}`).set({ uid, amount, date: new Date().toISOString() });
            }
        } catch (e) { console.error("Webhook Error"); }
    }
    res.sendStatus(200);
});

app.get('/', (req, res) => res.send("Dagi Pro-Bingo Engine Online 🟢"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on ${PORT}`));

setInterval(() => {
    const host = process.env.RENDER_EXTERNAL_HOSTNAME;
    if (host) https.get(`https://${host}/`, () => console.log("Ping sent"));
}, 5 * 60 * 1000);
