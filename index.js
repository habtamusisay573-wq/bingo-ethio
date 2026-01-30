const admin = require('firebase-admin');
const express = require('express');
const https = require('https');
const app = express();

app.use(express.json());

// 1. Firebase Config (Environment Variables መጠቀም እንዳትረሳ)
// Render ወይም Heroku ላይ Environment Variables መሙላት አለብህ
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
const ADMIN_ID = "8431270634"; // የአንተ (የአድሚኑ) ID

// 2. ጌም ኢንጂን (The Logic Controller)
const Game = {
    timer: null,
    drawer: null,
    
    // ታይመሩን ለማስጀመር (Waiting State)
    startTimer: function(seconds) {
        this.stopAll();
        // ታይመር እየቆጠረ መሆኑን እንመዘግባለን
        db.ref('game').update({ isTimerRunning: true, timer: seconds });
        
        this.timer = setInterval(async () => {
            seconds--;
            // ታይመሩን በየሰከንዱ ዳታቤዝ ላይ እናዘምነዋለን
            await db.ref('game/timer').set(seconds);
            
            if (seconds <= 0) {
                this.stopAll();
                // ታይመር ሲያልቅ ጨዋታውን Active እናደርጋለን
                await db.ref('game').update({ status: 'active', isTimerRunning: false, timer: 0 });
                this.startDrawing();
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

                // አሸናፊ ከተገኘ ወይም ጨዋታው Active ካልሆነ እናቁመው
                if (!data || data.winner || data.status !== 'active') return this.stopAll();

                drawn = data.drawn || [];
                // ሁሉም ቁጥሮች (75) ከወጡ ጨዋታው ይቁም
                if (drawn.length >= 75) {
                    console.log("All numbers drawn. Resetting...");
                    return this.forceReset();
                }

                // ቁጥር መምረጥ (የወጣውን አይደግምም)
                let num;
                do { num = Math.floor(Math.random() * 75) + 1; } while (drawn.includes(num));
                
                drawn.push(num);
                await db.ref('game/drawn').set(drawn);
            } catch (error) {
                console.error("Drawing Error:", error);
            }
        }, 2000); // በየ 2 ሰከንዱ ቁጥር ያወጣል
    },

    // ሁሉንም ሂደቶች ማቆሚያ
    stopAll: function() {
        if (this.timer) clearInterval(this.timer);
        if (this.drawer) clearInterval(this.drawer);
        this.timer = null;
        this.drawer = null;
    },

    // Watchdog: ጨዋታው ከተበላሸ ወይም ተጫዋች ከሌለ Reset ያደርጋል
    checkAutoReset: function() {
        setInterval(async () => {
            try {
                const gameSnap = await db.ref('game').get();
                const gameData = gameSnap.val() || {};
                const playersSnap = await db.ref('online_players').get();
                const boardsSnap = await db.ref('reserved_boards').get();

                // 1. ጨዋታው Active ሆኖ ተጫዋች ከሌለ (Disconnect)
                if (gameData.status === 'active' && !playersSnap.exists()) {
                    console.log("No players found. Auto-Resetting...");
                    this.forceReset();
                }
                // 2. ታይመሩ አልቆ (Waiting ended) ማንም ካርቴላ ካልገዛ
                else if (gameData.status === 'waiting' && gameData.timer <= 0 && !boardsSnap.exists()) {
                    console.log("No bets placed. Auto-Resetting...");
                    this.forceReset();
                }
            } catch (e) { console.error("Auto-Reset Check Error:", e); }
        }, 5000); // በየ 5 ሰከንዱ ይፈትሻል
    },

    // ጨዋታውን ወደ ዜሮ መመለሻ
    forceReset: async function() {
        this.stopAll();
        await db.ref('reserved_boards').remove();
        await db.ref('game').update({
            drawn: [], status: 'idle', winner: null, timer: -1, jackpot: 0, isTimerRunning: false
        });
        console.log("System Cleaned via Force Reset 🧹");
    }
};

// Auto-Reset አገልግሎትን አስጀምር
Game.checkAutoReset();

// 3. Firebase Listeners (Real-time Events)

// ሀ. ጨዋታው Waiting ሲሆን ታይመር አስጀምር
db.ref('game/status').on('value', snap => {
    if (snap.val() === 'waiting') Game.startTimer(30);
});

// ለ. አሸናፊ ሲኖር (Payout Logic)
db.ref('game/winner').on('value', async snap => {
    const win = snap.val();
    if (win && !win.processed) {
        Game.stopAll();
        console.log(`Winner detected: ${win.name}`);

        try {
            // የተያዙ ካርቴላዎችን በሙሉ ደምሮ ጃክፖቱን ማስላት
            const boardsSnap = await db.ref('reserved_boards').get();
            let totalPool = 0;
            
            boardsSnap.forEach(child => {
                const bet = parseFloat(child.val().betAmount) || 0;
                totalPool += bet;
            });

            if (totalPool > 0) {
                const winnerShare = totalPool * 0.8; // 80% ለተጫዋች
                const adminShare = totalPool * 0.2;  // 20% ለአድሚን

                // ክፍያ መፈጸም (Transaction ይጠቀማል - ለደህንነት)
                await db.ref(`users/${win.id}/bal`).transaction(c => (c || 0) + winnerShare);
                await db.ref(`users/${ADMIN_ID}/bal`).transaction(c => (c || 0) + adminShare);

                // HISTORY LOGGING (ለተጫዋቹ ታሪክ መመዝገብ)
                // ማሳሰቢያ: ts (timestamp) ተጨምሯል - ለ Auto-cleanup ይጠቅማል
                await db.ref(`history/${win.id}`).push({
                    type: "ቢንጎ አሸናፊ 🏆",
                    amt: winnerShare,
                    mode: "PLUS",
                    date: new Date().toLocaleString('am-ET'),
                    ts: Date.now() 
                });
                
                console.log(`Paid ${winnerShare} to ${win.name}`);
            }

            // ክፍያው እንደተፈጸመ ምልክት ማድረግ
            await db.ref('game/winner/processed').set(true);

            // ከ 5 ሰከንድ በኋላ አዲስ ጨዋታ ማስጀመር
            setTimeout(() => Game.forceReset(), 5000);
            
        } catch (error) {
            console.error("Payout Error:", error);
            // ስህተት ከተፈጠረም ጨዋታውን Reset ማድረግ ደህንነቱ የተጠበቀ ነው
            setTimeout(() => Game.forceReset(), 5000);
        }
    }
});

// 4. API Endpoints (Webhook & Others)

// SMS Webhook (ከቴሌብር የሚመጣውን ሜሴጅ ተቀብሎ በራስ ሰር ብር ማስገቢያ)
// ይህ እንዲሰራ "SMS Forwarder" አፕ መጠቀም አለብህ
app.post('/sms-webhook', async (req, res) => {
    const { text, message } = req.body;
    const msg = text || message || "";
    
    // Regex Patterns (የቴሌብርን ሜሴጅ ለመለየት)
    const txMatch = msg.match(/[A-Z0-9]{10,12}/i); // Transaction ID
    const amtMatch = msg.match(/(\d+(?:\.\d+)?)\s?(?:ETB|ብር)/i); // Amount
    const phMatch = msg.match(/(?:\+251|0)(9\d{8}|7\d{8})/); // Phone Number

    if (txMatch && amtMatch && phMatch) {
        const txId = txMatch[0].toUpperCase();
        const amount = parseFloat(amtMatch[1]);
        const phone = '0' + phMatch[1]; // ወደ 09... ቀይሮ መጠቀም

        try {
            // ይህ Transaction ID ከዚህ በፊት ጥቅም ላይ መዋሉን ማረጋገጥ
            const txCheck = await db.ref(`used_transactions/${txId}`).get();
            if (txCheck.exists()) return res.sendStatus(200);

            // ስልክ ቁጥሩን ከዳታቤዝ መፈለግ
            const userSnap = await db.ref('users').orderByChild('phone').equalTo(phone).once('value');
            
            if (userSnap.exists()) {
                const uid = Object.keys(userSnap.val())[0];
                
                // ክፍያ መጨመር
                await db.ref(`users/${uid}/bal`).transaction(c => (c || 0) + amount);
                
                // ታሪክ መመዝገብ
                await db.ref(`history/${uid}`).push({
                    type: "በቴሌብር ገቢ ተደርጓል ✅",
                    amt: amount,
                    mode: "PLUS",
                    date: new Date().toLocaleString('am-ET'),
                    ts: Date.now()
                });

                // Transaction ID መመዝገብ (ደጋግሞ እንዳይጠቀም)
                await db.ref(`used_transactions/${txId}`).set({ 
                    uid, amount, date: new Date().toISOString() 
                });
                console.log(`Deposited ${amount} to ${phone}`);
            }
        } catch (e) { console.error("Webhook Error:", e); }
    }
    res.sendStatus(200);
});

// Health Check & Port
app.get('/', (req, res) => res.send("Dagi Pro-Bingo Engine Online 🟢"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on ${PORT}`));

// Keep-Alive Ping (ለ Render/Replit እንዳይተኛ)
setInterval(() => {
    const host = process.env.RENDER_EXTERNAL_HOSTNAME;
    if (host) https.get(`https://${host}/`, () => console.log("Ping sent"));
}, 5 * 60 * 1000);
