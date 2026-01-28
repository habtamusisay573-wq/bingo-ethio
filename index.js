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

    // ቁጥሮችን በየ 4 ሰከንዱ ለማውጣት
    startDrawing: function() {
        let nums = Array.from({length: 75}, (_, i) => i + 1);
        let drawn = [];
        
        this.drawer = setInterval(async () => {
            if (nums.length === 0) {
                this.stopAll();
                return;
            }
            
            let randomIndex = Math.floor(Math.random() * nums.length);
            let number = nums.splice(randomIndex, 1)[0];
            drawn.push(number);
            
            await db.ref('game/drawn').set(drawn);
        }, 4000);
    },

    // ሁሉንም ሂደቶች ለማቆም
    stopAll: function() {
        if (this.timer) clearInterval(this.timer);
        if (this.drawer) clearInterval(this.drawer);
    },

    // --- አዲስ የተጨመረ፡ በየ 3 ሰከንዱ ጌሙን የሚቆጣጠር AUTO RESET ---
    checkAutoReset: function() {
        setInterval(async () => {
            try {
                const gameSnap = await db.ref('game').get();
                const gameData = gameSnap.val() || {};
                const boardsSnap = await db.ref('reserved_boards').get();
                const onlineSnap = await db.ref('online_players').get();

                // ጌሙ ተጀምሮ (Waiting ወይም Active) ግን ምንም የተገዛ ካርቴላ ከሌለ
                if (gameData.status !== 'idle' && !boardsSnap.exists()) {
                    console.log("Auto-Reset: ተጫዋች የለም፣ ጌሙ እየጸዳ ነው...");
                    this.forceReset();
                }
                // ጌሙ ከተጀመረ በኋላ ሁሉም ተጫዋቾች ከወጡ (Offline ከሆኑ)
                else if (gameData.status === 'active' && !onlineSnap.exists()) {
                    console.log("Auto-Reset: ሁሉም ተጫዋቾች ወጥተዋል፣ ጌሙ እየጸዳ ነው...");
                    this.forceReset();
                }
            } catch (err) {
                console.error("Reset Monitor Error:", err);
            }
        }, 3000);
    },

    // ጌሙን ወደ መጀመሪያው ሁኔታ ለመመለስ
    forceReset: async function() {
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
    }
};

// ሲስተሙ ሲነሳ ክትትሉን ይጀምራል
Game.checkAutoReset();

// 3. Firebase Listeners (Winner Detection)
db.ref('game/winner').on('value', async (snap) => {
    if (snap.val()) {
        Game.stopAll();
        // አሸናፊ ሲኖር ከ 5 ሰከንድ በኋላ ጌሙን ያጸዳል
        setTimeout(async () => {
            await db.ref('reserved_boards').remove();
            await db.ref('game').update({
                drawn: [],
                status: 'idle',
                winner: null,
                timer: -1,
                jackpot: 0
            });
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
app.get('/', (req, res) => res.send('Bingo Server is Live!'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
