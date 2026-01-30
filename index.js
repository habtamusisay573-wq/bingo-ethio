const admin = require('firebase-admin');
const express = require('express'); 
const app = express(); 

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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

// 2. ጌም ኢንጂን ሎጂክ
let drawingInterval = null; 
let timerInterval = null;
let resetTimeout = null;

// ሁሉንም ሪሴት ማድረጊያ ፈንክሽን
async function resetFullGame(reason) {
    console.log(`Reset Triggered: ${reason}`);
    if (drawingInterval) clearInterval(drawingInterval);
    if (timerInterval) clearInterval(timerInterval);
    
    await db.ref('reserved_boards').remove();
    await db.ref('game').update({
        drawn: [], 
        status: 'idle', 
        winner: null, 
        timer: -1, 
        currentBetPrice: 0, 
        isTimerRunning: false, 
        isResetting: false
    });
}

// አሸናፊ ሲኖር ክፍያ መፈጸም (Jackpot Logic)
db.ref('game/winner').on('value', async (snap) => {
    const winner = snap.val();
    
    // አሸናፊ ካለ እና ክፍያው ገና ካልተፈጸመ (processed false ከሆነ)
    if (winner && winner.id && winner.processed === false) {
        if (drawingInterval) clearInterval(drawingInterval);

        try {
            // *** የJACKPOT ስሌት ማስተካከያ ***
            const boardsSnap = await db.ref('reserved_boards').get();
            let totalPool = 0;
            
            if (boardsSnap.exists()) {
                boardsSnap.forEach(child => {
                    const boardData = child.val();
                    // የሁሉንም ካርቴላዎች መጫወቻ ዋጋ መደመር
                    totalPool += (parseFloat(boardData.betAmount) || 0);
                });
            }

            if (totalPool > 0) {
                const winnerPay = totalPool * 0.8; // 80% ለአሸናፊው
                const adminPay = totalPool * 0.2;  // 20% ለቤቱ (Admin)

                // ለአሸናፊው ሂሳብ ገቢ ማድረግ
                await db.ref(`users/${winner.id}/bal`).transaction(current => (current || 0) + winnerPay);
                
                // ለAdmin ሂሳብ ገቢ ማድረግ
                await db.ref(`users/${ADMIN_ID}/bal`).transaction(current => (current || 0) + adminPay);
                
                // የታሪክ መዝገብ (History)
                await db.ref(`history/${winner.id}`).push({
                    type: "የቢንጎ ድል 🏆", 
                    amt: winnerPay, 
                    date: new Date().toLocaleString('en-US', { timeZone: 'Africa/Addis_Ababa' })
                });
                
                console.log(`Payout Processed: TotalPool: ${totalPool}, Winner: ${winnerPay}`);
            }

            // ክፍያው መጠናቀቁን መመዝገብ (Double payment እንዳይፈጠር)
            await db.ref('game/winner/processed').set(true);
            
            // ከ3 ሰከንድ በኋላ ጌሙን ሪሴት ማድረግ
            setTimeout(() => resetFullGame("Post-Win Reset"), 3000); 
        } catch (e) { 
            console.error("Payout Error:", e); 
        }
    }
});

// ተጫዋች ሲጠፋ ሪሴት ማድረግ (Watchdog)
db.ref('online_players').on('value', (snapshot) => {
    if (snapshot.numChildren() === 0) {
        if (resetTimeout) clearTimeout(resetTimeout);
        resetTimeout = setTimeout(async () => {
            const gameSnap = await db.ref('game').get();
            const g = gameSnap.val();
            if (g && g.status !== 'idle') resetFullGame("Inactivity Reset");
        }, 3000);
    } else {
        if (resetTimeout) clearTimeout(resetTimeout);
    }
});

// ታይመር ማስጀመር
db.ref('game/status').on('value', snap => {
    if (snap.val() === 'waiting') runTimer();
});

function runTimer() {
    db.ref('game').once('value', async (snap) => {
        const data = snap.val();
        if (data.isTimerRunning) return;
        
        await db.ref('game/isTimerRunning').set(true);
        let sec = 30;
        
        timerInterval = setInterval(async () => {
            sec--;
            await db.ref('game/timer').set(sec);
            if(sec <= 0) {
                clearInterval(timerInterval);
                await db.ref('game').update({ status: 'active', isTimerRunning: false });
                startDrawingNumbers([]);
            }
        }, 1000);
    });
}

function startDrawingNumbers(existingDrawn) {
    let drawn = existingDrawn || [];
    drawingInterval = setInterval(async () => {
        const gameSnap = await db.ref('game').get();
        const g = gameSnap.val();
        
        if(!g || g.winner || g.status !== 'active') {
            return clearInterval(drawingInterval);
        }

        if (drawn.length >= 75) {
            clearInterval(drawingInterval);
            return;
        }

        let n;
        do { 
            n = Math.floor(Math.random() * 75) + 1; 
        } while(drawn.includes(n));
        
        drawn.push(n);
        await db.ref('game/drawn').set(drawn);
    }, 2000);
}

// 3. Webhook (ቴሌብር/SMS)
app.post('/sms-webhook', async (req, res) => {
    const message = req.body.text || req.body.message || "";
    const txIdMatch = message.match(/[A-Z0-9]{10,12}/i); 
    const amountMatch = message.match(/(\d+(?:\.\d+)?)\s?(?:ETB|ብር)/i);
    const phMatch = message.match(/(?:\+251|0)(9\d{8}|7\d{8})/);

    if (txIdMatch && amountMatch) {
        const txId = txIdMatch[0].toUpperCase();
        const amount = parseFloat(amountMatch[1]);
        const phone = phMatch ? '0' + phMatch[1] : null;

        try {
            const txCheck = await db.ref(`used_transactions/${txId}`).once('value');
            if (!txCheck.exists() && phone) {
                const userSnap = await db.ref('users').orderByChild('phone').equalTo(phone).once('value');
                if (userSnap.exists()) {
                    const userData = userSnap.val();
                    const uid = Object.keys(userData)[0];
                    await db.ref(`users/${uid}/bal`).transaction(c => (c || 0) + amount);
                    await db.ref(`used_transactions/${txId}`).set({ 
                        uid, 
                        amount, 
                        date: new Date().toISOString() 
                    });
                }
            }
        } catch (e) { 
            console.error("Webhook Error"); 
        }
    }
    res.sendStatus(200);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bingo Server Live on ${PORT}`));
