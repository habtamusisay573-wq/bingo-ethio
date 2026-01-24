const admin = require('firebase-admin');
const express = require('express'); // አዲስ የተጨመረ
const bodyParser = require('body-parser'); // አዲስ የተጨመረ
const app = express();

app.use(bodyParser.json());

// --- 🎯 STEP: የቴሌብር SMS መቀበያ (Webhook) ---
app.post('/sms-webhook', async (req, res) => {
    const { message } = req.body;
    console.log("አዲስ SMS ደርሷል:", message);

    // ቴሌብር መልእክት ፎርማት መፈለጊያ (Regex)
    const amountMatch = message.match(/(?:ETB|ብር)\s*(\d+(\.\d+)?)/i);
    const senderPhoneMatch = message.match(/(09\d{8}|2519\d{8}|07\d{8}|2517\d{8})/);
    const trxMatch = message.match(/(?:ID|Trx|Ref):\s*([A-Z0-9]+)/i);

    if (amountMatch && senderPhoneMatch && trxMatch) {
        const amount = parseFloat(amountMatch[1]);
        let rawPhone = senderPhoneMatch[0];
        const trxId = trxMatch[1];
        const cleanPhone = rawPhone.replace('251', '0');

        // በስልክ ቁጥሩ ተጫዋቹን መፈለግ
        const userSnapshot = await db.ref('users').orderByChild('phone').equalTo(cleanPhone).once('value');
        
        if (userSnapshot.exists()) {
            const userData = userSnapshot.val();
            const uid = Object.keys(userData)[0];
            const usedTrx = await db.ref('used_transactions').child(trxId).get();
            
            if (!usedTrx.exists()) {
                // 💰 ባላንስ መጨመር
                await db.ref(`users/${uid}/bal`).transaction(curr => (curr || 0) + amount);
                await db.ref(`history/${uid}`).push({
                    type: "DEP (AUTO)", amt: amount, status: 'Approved', info: `Telebirr ID: ${trxId}`, date: new Date().toLocaleString()
                });
                await db.ref('used_transactions').child(trxId).set({ uid, amount, date: Date.now() });
                console.log(`✅ ለስልክ ${cleanPhone} (${uid}) ${amount} ብር በራስ-ሰር ተሞልቷል!`);
            }
        }
    }
    res.status(200).send("OK");
});

// ሰርቨር እንዳይዘጋ እና ዌብሁክ እንዲሰራ
app.get('/', (req, res) => res.send('Bingo Server Active'));
app.listen(process.env.PORT || 3000, () => console.log("Bingo Server & Payment Webhook Running..."));

const serviceAccount = {
  projectId: process.env.PROJECT_ID,
  clientEmail: process.env.CLIENT_EMAIL,
  privateKey: process.env.PRIVATE_KEY.replace(/\\n/g, '\n'),
};

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: "https://dagi-bingo-default-rtdb.firebaseio.com"
  });
}

const db = admin.database();
const ADMIN_ID = "8431270634";

// --- ያንተ የቀድሞ Logic (Reset, Payment, Timer) በሙሉ ከታች ይቀጥላል ---
let resetTimeout = null;

db.ref('online_players').on('value', (snapshot) => {
    const playerCount = snapshot.numChildren();
    if (playerCount === 0) {
        if (resetTimeout) clearTimeout(resetTimeout);
        resetTimeout = setTimeout(async () => {
            const gameSnap = await db.ref('game').get();
            const gameData = gameSnap.val();
            if (gameData && gameData.status !== 'idle') {
                await db.ref('reserved_boards').remove();
                await db.ref('game').update({
                    drawn: [], status: 'idle', winner: null, isResetting: false, timer: -1, currentBetPrice: 0, isTimerRunning: false
                });
            }
        }, 3000);
    } else if (resetTimeout) { clearTimeout(resetTimeout); resetTimeout = null; }
});

async function checkServerRecovery() {
    const gameSnap = await db.ref('game').get();
    const gameData = gameSnap.val();
    if(gameData && gameData.status === 'active' && !gameData.winner) {
        startDrawingNumbers(gameData.drawn || []);
    }
}
checkServerRecovery();

db.ref('game').on('value', async (snap) => {
    const game = snap.val();
    if(!game) return;
    if(game.winner && !game.isResetting) {
        await db.ref('game/isResetting').set(true);
        const winnerId = game.winner.id;
        const betPrice = game.currentBetPrice || 0;
        const boardsSnap = await db.ref('reserved_boards').get();
        const playersCount = boardsSnap.numChildren();
        const totalPool = playersCount * betPrice;
        const winnerPay = totalPool * 0.8;
        const adminPay = totalPool * 0.2;
        try {
            await db.ref(`users/${winnerId}/bal`).transaction(curr => (curr || 0) + winnerPay);
            await db.ref(`history/${winnerId}`).push({
                type: "የቢንጎ ድል 🏆", amt: winnerPay, info: "80% የአሸናፊ ድርሻ", date: new Date().toLocaleString()
            });
            await db.ref(`users/${ADMIN_ID}/bal`).transaction(curr => (curr || 0) + adminPay);
            await db.ref('admin_logs').push({
                winner: game.winner.name, total: totalPool, adminShare: adminPay, date: new Date().toLocaleString()
            });
        } catch (e) { console.error("Payment Failed", e); }
        setTimeout(() => {
            db.ref('reserved_boards').remove();
            db.ref('game').set({ drawn: [], status: 'idle', winner: null, isResetting: false, timer: -1, currentBetPrice: 0 });
        }, 5000);
    }
    if(game.status === 'waiting' && !game.isTimerRunning) { runTimer(); }
});

function runTimer() {
    db.ref('game').update({ isTimerRunning: true });
    let sec = 30;
    const interval = setInterval(() => {
        sec--;
        db.ref('game/timer').set(sec);
        if(sec <= 0) {
            clearInterval(interval);
            db.ref('game').update({ status: 'active', isTimerRunning: false });
            startDrawingNumbers([]);
        }
    }, 1000);
}

function startDrawingNumbers(existingDrawn) {
    let drawn = existingDrawn;
    const interval = setInterval(async () => {
        const g = (await db.ref('game').get()).val();
        if(!g || g.winner || g.status !== 'active' || drawn.length >= 75) { clearInterval(interval); return; }
        let n; do { n = Math.floor(Math.random() * 75) + 1; } while(drawn.includes(n));
        drawn.push(n);
        db.ref('game/drawn').set(drawn);
    }, 4000);
}
