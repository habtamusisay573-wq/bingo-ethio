const admin = require('firebase-admin');
const express = require('express');
const app = express();

app.use(express.json());

// 1. Firebase Config (ከ Environment Variables የሚነበብ)
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
const ADMIN_ID = "8431270634"; // ያንተ ID

// 2. ጌም ኢንጂን (The Logic Controller)
const Game = {
    timer: null,
    drawer: null,
    
    // ታይመሩን ለማስጀመር (Waiting State)
    startTimer: function(seconds) {
        this.stopAll();
        db.ref('game').update({ 
            status: 'waiting', 
            isTimerRunning: true, 
            timer: seconds, 
            winner: null, 
            drawn: [] 
        });
        
        this.timer = setInterval(async () => {
            seconds--;
            await db.ref('game/timer').set(seconds);
            
            if (seconds <= 0) {
                this.stopAll();
                const boardsSnap = await db.ref('reserved_boards').get();
                // ካርቴላ የገዛ ሰው ካለ ጨዋታው ይጀምራል
                if (boardsSnap.exists()) {
                    await db.ref('game').update({ status: 'active', isTimerRunning: false, timer: 0 });
                    this.startDrawing();
                } else {
                    console.log("No bets placed. Resetting to idle...");
                    this.forceReset();
                }
            }
        }, 1000);
    },

    // ቁጥር ማውጣት ለመጀመር (Active State)
    startDrawing: function() {
        let drawn = [];
        this.drawer = setInterval(async () => {
            try {
                const snap = await db.ref('game').get();
                const data = snap.val();

                // አሸናፊ ከተገኘ ወይም ጨዋታው ካልጀመረ ይቆማል
                if (!data || data.winner || data.status !== 'active') return this.stopAll();

                drawn = data.drawn || [];
                // 75 ቁጥር ከወጣ ማንም ካላሸነፈ Reset ያደርጋል
                if (drawn.length >= 75) return this.forceReset();

                let num;
                do { num = Math.floor(Math.random() * 75) + 1; } while (drawn.includes(num));
                
                drawn.push(num);
                await db.ref('game/drawn').set(drawn);
            } catch (error) { console.error("Drawing Error:", error); }
        }, 2500); // ፍጥነቱ በየ 2.5 ሰከንድ
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
    }
};

// 3. አሸናፊ ሲኖር ክፍያ የመፈጸም ህግ (80% / 20%)
db.ref('game/winner').on('value', async snap => {
    const win = snap.val();
    if (win && !win.processed) {
        Game.stopAll(); // ቁጥር ማውጣት ይቆማል
        try {
            const boardsSnap = await db.ref('reserved_boards').get();
            let totalPool = 0;
            
            boardsSnap.forEach(child => {
                // እዚህ ጋር የ 10 ብር ስሌት ተስተካክሏል
                totalPool += (parseFloat(child.val().betAmount) || 0);
            });

            if (totalPool > 0) {
                const winnerShare = totalPool * 0.8; // 80% ለአሸናፊ
                const adminShare = totalPool * 0.2;  // 20% ለአንተ

                // ብር ገቢ ማድረግ
                await db.ref(`users/${win.id}/bal`).transaction(c => (c || 0) + winnerShare);
                await db.ref(`users/${ADMIN_ID}/bal`).transaction(c => (c || 0) + adminShare);
                
                // ታሪክ ላይ መመዝገብ
                await db.ref(`history/${win.id}`).push({
                    type: "የቢንጎ ድል 🏆",
                    amt: winnerShare,
                    mode: "PLUS",
                    date: new Date().toLocaleString('am-ET')
                });
            }

            // ክፍያው መፈጸሙን ምልክት ማድረግ
            await db.ref('game/winner/processed').set(true);
            
            // ከ 5 ሰከንድ በኋላ ለቀጣይ ዙር Reset ያደርጋል
            setTimeout(() => { Game.forceReset(); }, 5000);
            
        } catch (e) { console.error("Payout Error:", e); }
    }
});

// 4. አዲስ ተጫዋች ካርቴላ ሲገዛ ታይመር ይጀምራል
db.ref('reserved_boards').on('child_added', async () => {
    const gameSnap = await db.ref('game').get();
    const game = gameSnap.val() || {};
    // ጨዋታው ካልጀመረ ወይም ታይመሩ ካልቆጠረ ብቻ ይጀምር
    if (game.status === 'idle' || !game.isTimerRunning) {
        Game.startTimer(30); 
    }
});

// 5. Watchdog (ተጫዋች ከጠፋ Reset ለማድረግ)
setInterval(async () => {
    const playersSnap = await db.ref('online_players').get();
    const gameSnap = await db.ref('game').get();
    const game = gameSnap.val() || {};
    
    if (game.status === 'active' && !playersSnap.exists()) {
        console.log("No players online. Auto-resetting...");
        Game.forceReset();
    }
}, 10000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bingo Engine is Active on Port ${PORT}`));
