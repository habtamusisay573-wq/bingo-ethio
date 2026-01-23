const admin = require('firebase-admin');
const http = require('http');

// Simple Health Check Server
http.createServer((req, res) => {
  res.writeHead(200); res.end('Bingo Server Active');
}).listen(process.env.PORT || 3000);

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
const ADMIN_ID = process.env.ADMIN_ID || "8431270634";

let drawingInterval = null;
let claimGraceTimeout = null;
let isProcessingPayout = false;

// --- 1. CLEANUP Logic ---
db.ref('online_players').on('value', (snapshot) => {
    if (snapshot.numChildren() === 0) {
        setTimeout(async () => {
            const snap = await db.ref('game').get();
            const onlineSnap = await db.ref('online_players').get();
            if (onlineSnap.numChildren() === 0 && snap.val() && snap.val().status !== 'idle') {
                stopDrawing(); // ማውጫውን ወዲያውኑ ማቆሚያ ተግባር
                await db.ref('reserved_boards').remove();
                await db.ref('game').update({
                    drawn: [], status: 'idle', winners: null, claims: null, 
                    timer: -1, isTimerRunning: false, currentBetPrice: 0
                });
            }
        }, 5000);
    }
});

// ቁጥር ማውጣቱን ወዲያውኑ ለማቆም የምትረዳ ተግባር
function stopDrawing() {
    if (drawingInterval) {
        clearInterval(drawingInterval);
        drawingInterval = null;
    }
}

// --- 2. CLAIMS MONITOR ---
db.ref('game/claims').on('value', async (snap) => {
    const claims = snap.val();
    if (!claims || claimGraceTimeout || isProcessingPayout) return;

    // *** ዋና ለውጥ፡ ቢንጎ እንደተባለ (Claim እንደመጣ) ወዲያውኑ ቁጥር ማውጣቱን አቁም ***
    stopDrawing();

    claimGraceTimeout = setTimeout(async () => {
        if (isProcessingPayout) return;
        isProcessingPayout = true;

        try {
            const currentClaimsSnap = await db.ref('game/claims').get();
            const allClaims = currentClaimsSnap.val() || {};
            const winnersList = Object.values(allClaims);
            const winnersCount = winnersList.length;

            const gameSnap = await db.ref('game').get();
            const boardsSnap = await db.ref('reserved_boards').get();
            const gameData = gameSnap.val();
            const boardsData = boardsSnap.val();

            if (!gameData || !boardsData) {
                isProcessingPayout = false;
                claimGraceTimeout = null;
                return;
            }

            const betPrice = gameData.currentBetPrice || 0;
            const totalPlayers = boardsSnap.numChildren();
            const totalPool = totalPlayers * betPrice;

            if (winnersCount >= 3) {
                const refundPromises = Object.values(boardsData).map(player => {
                    return db.ref(`users/${player.userId}/bal`).transaction(c => (c || 0) + player.betAmount)
                        .then(() => db.ref(`history/${player.userId}`).push({
                            type: "Refund (Draw)", amt: player.betAmount, status: "Completed", date: new Date().toLocaleString()
                        }));
                });
                await Promise.all(refundPromises);
            } else {
                const winnerShareRatio = winnersCount === 2 ? 0.4 : 0.8; 
                const adminShareRatio = 0.2;

                for (const winner of winnersList) {
                    const prize = totalPool * winnerShareRatio;
                    await db.ref(`users/${winner.id}/bal`).transaction(c => (c || 0) + prize);
                    await db.ref(`history/${winner.id}`).push({
                        type: "Bingo Win 🏆", amt: prize, status: "Completed", date: new Date().toLocaleString()
                    });
                }
                await db.ref(`users/${ADMIN_ID}/bal`).transaction(c => (c || 0) + (totalPool * adminShareRatio));
            }

            await db.ref('game/winners').set(allClaims);
            
            setTimeout(async () => {
                await db.ref('reserved_boards').remove();
                await db.ref('game').update({
                    drawn: [], status: 'idle', winners: null, claims: null, 
                    timer: -1, isTimerRunning: false, currentBetPrice: 0
                });
                isProcessingPayout = false;
                claimGraceTimeout = null;
            }, 4000);

        } catch (error) {
            console.error("Payout Error:", error);
            isProcessingPayout = false;
            claimGraceTimeout = null;
        }
    }, 3000); 
});

// --- 3. TIMER Logic ---
db.ref('game').on('value', (snap) => {
    const game = snap.val();
    if(game && game.status === 'waiting' && !game.isTimerRunning) {
        runTimer();
    }
});

function runTimer() {
    db.ref('game').update({ isTimerRunning: true });
    let sec = 30;
    const interval = setInterval(async () => {
        sec--;
        await db.ref('game/timer').set(sec);
        if (sec <= 0) {
            clearInterval(interval);
            await db.ref('game').update({ status: 'active', isTimerRunning: false });
            startDrawingNumbers();
        }
    }, 1000);
}

// --- 4. NUMBER DRAWING Logic ---
function startDrawingNumbers() {
    stopDrawing(); // አዲስ ከመጀመሩ በፊት የቆየውን አጽዳ
    
    let drawn = [];
    drawingInterval = setInterval(async () => {
        // ቁጥር ከማውጣቱ በፊት አሸናፊ መኖሩን በሰከንድ ውስጥ ቼክ ያደርጋል
        const gameSnap = await db.ref('game').get();
        const g = gameSnap.val();

        // አሸናፊ ካለ ወይም ጨዋታው ካበቃ ወዲያውኑ ቁልፉን ይዘጋል
        if (!g || g.winners || g.claims || g.status !== 'active' || drawn.length >= 75) {
            stopDrawing();
            return;
        }

        let n;
        do { n = Math.floor(Math.random() * 75) + 1; } while (drawn.includes(n));
        
        drawn.push(n);
        await db.ref('game/drawn').set(drawn);
    }, 4000);
}
