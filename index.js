const admin = require('firebase-admin');
const express = require('express');
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
const ADMIN_ID = "8431270634"; // የአድሚን ID

// 2. ጌም ኢንጂን (The Logic Controller)
const Game = {
    timer: null,
    drawer: null,
    
    // ታይመሩን ለማስጀመር (Waiting State)
    startTimer: function(seconds) {
        this.stopAll();
        // status ን ወደ waiting መቀየር ለ HTML በጣም አስፈላጊ ነው
        db.ref('game').update({ 
            status: 'waiting', 
            isTimerRunning: true, 
            timer: seconds, 
            winner: null, 
            drawn: [] 
        });
        
        console.log("Timer started: 30s");

        this.timer = setInterval(async () => {
            seconds--;
            await db.ref('game/timer').set(seconds);
            
            if (seconds <= 0) {
                this.stopAll();
                const boardsSnap = await db.ref('reserved_boards').get();
                
                if (boardsSnap.exists()) {
                    // ካርቴላ የገዛ ካለ ወደ 'active' ይቀየራል - HTML ገጽ እንዲቀይር የሚያደርገው ይሄ ነው
                    await db.ref('game').update({ status: 'active', isTimerRunning: false, timer: 0 });
                    this.startDrawing();
                } else {
                    console.log("No boards reserved. Resetting...");
                    this.forceReset();
                }
            }
        }, 1000);
    },

    // ቁጥር ማውጣት (Active State)
    startDrawing: function() {
        let drawn = [];
        console.log("Game Active: Drawing numbers...");
        this.drawer = setInterval(async () => {
            try {
                const snap = await db.ref('game').get();
                const data = snap.val();

                if (!data || data.winner || data.status !== 'active') {
                    return this.stopAll();
                }

                drawn = data.drawn || [];
                if (drawn.length >= 75) return this.forceReset();

                let num;
                do { 
                    num = Math.floor(Math.random() * 75) + 1; 
                } while (drawn.includes(num));
                
                drawn.push(num);
                await db.ref('game/drawn').set(drawn);
            } catch (error) { 
                console.error("Drawing Error:", error); 
            }
        }, 2500); // በየ 2.5 ሰከንዱ
    },

    stopAll: function() {
        if (this.timer) clearInterval(this.timer);
        if (this.drawer) clearInterval(this.drawer);
        this.timer = null;
        this.drawer = null;
    },

    forceReset: function() {
        this.stopAll();
        db.ref('game').update({ 
            status: 'idle', 
            timer: -1, 
            drawn: [], 
            winner: null, 
            jackpot: 0, 
            isTimerRunning: false 
        });
        db.ref('reserved_boards').remove();
        console.log("Game Reset to Idle");
    }
};

// 3. አሸናፊ ሲኖር ክፍያ የመፈጸም ህግ (80% / 20%)
db.ref('game/winner').on('value', async snap => {
    const win = snap.val();
    if (win && !win.processed) {
        Game.stopAll(); 
        console.log("Winner found! Processing payout...");
        try {
            const boardsSnap = await db.ref('reserved_boards').get();
            let totalPool = 0;
            
            boardsSnap.forEach(child => {
                totalPool += (parseFloat(child.val().betAmount) || 0);
            });

            if (totalPool > 0) {
                const winnerShare = totalPool * 0.8;
                const adminShare = totalPool * 0.2;

                // ለአሸናፊው
                await db.ref(`users/${win.id}/bal`).transaction(c => (c || 0) + winnerShare);
                // ለአድሚኑ
                await db.ref(`users/${ADMIN_ID}/bal`).transaction(c => (c || 0) + adminShare);
                
                // ታሪክ ምዝገባ
                await db.ref(`history/${win.id}`).push({
                    type: "የቢንጎ ድል 🏆",
                    amt: winnerShare,
                    mode: "PLUS",
                    date: new Date().toLocaleString('am-ET')
                });
            }

            await db.ref('game/winner/processed').set(true);
            // አሸናፊው ካሸነፈ በኋላ ለ 7 ሰከንድ ውጤቱ እንዲታይ ቆይቶ Reset ያደርጋል
            setTimeout(() => { Game.forceReset(); }, 7000);
            
        } catch (e) { console.error("Payout Error:", e); }
    }
});

// 4. አዲስ ተጫዋች ካርቴላ ሲገዛ ታይመር ይጀምራል
db.ref('reserved_boards').on('child_added', async () => {
    const gameSnap = await db.ref('game').get();
    const game = gameSnap.val() || {};
    // ጨዋታው ካልጀመረ ታይመሩን አስነሳ
    if (game.status === 'idle' || !game.status) {
        Game.startTimer(30); 
    }
});

// 5. Watchdog (ሁኔታዎችን መቆጣጠሪያ)
setInterval(async () => {
    const playersSnap = await db.ref('online_players').get();
    const gameSnap = await db.ref('game').get();
    const game = gameSnap.val() || {};
    
    // ተጫዋች ከጠፋ Reset
    if (game.status === 'active' && !playersSnap.exists()) {
        Game.forceReset();
    }
}, 10000);

// 6. ለቴሌብር Webhook ወይም ለሌላ ጥያቄዎች (ካለህ)
app.get('/', (req, res) => res.send("Bingo Engine is Running..."));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server started on port ${PORT}`);
    // ሲጀመር ዳታቤዙን አንድ ጊዜ ያጸዳዋል (ለጥንቃቄ)
    db.ref('game/status').once('value', s => {
        if(!s.exists()) Game.forceReset();
    });
});
