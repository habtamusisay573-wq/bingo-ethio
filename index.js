<!-- ⚠️ NOTE:
Draw, Auto Draw, Timer Start, Reset Game
አሁን ሁሉም server.js ላይ ብቻ ነው
UI እና listener ብቻ ቀርቷል
-->

<script>
/* ========= ADMIN CONTROLS (SERVER-ONLY MODE) ========= */

function drawNum() {
    alert("ℹ️ Draw አሁን በServer ብቻ ይከናወናል");
}

function toggleAutoDraw() {
    alert("ℹ️ AUTO DRAW በServer ብቻ ነው");
}

function resetGame() {
    alert("ℹ️ RESET በServer ራሱ ይከናወናል");
}

/* ========= TIMER (DISPLAY ONLY) ========= */

db.ref('game/timer').on('value', s => {
    const v = s.val();
    const t = document.getElementById('timer-display');
    const sec = document.getElementById('timer-sec');

    if (v > 0) {
        t.style.display = 'block';
        sec.innerText = v;
    } else {
        t.style.display = 'none';
    }
});

/* ========= GAME STATUS ========= */

db.ref('game/status').on('value', s => {
    const st = s.val();
    if(st === 'waiting') {
        document.getElementById('game-status-text').innerText = "● መጠባበቂያ ላይ...";
    }
    if(st === 'active') {
        document.getElementById('game-status-text').innerText = "● ጨዋታ ተጀምሯል";
    }
});

/* ========= WINNER ========= */

function checkBingoAndClaim() {
    const lines = [
        [0,1,2,3,4],[5,6,7,8,9],[10,11,12,13,14],
        [15,16,17,18,19],[20,21,22,23,24],
        [0,5,10,15,20],[1,6,11,16,21],[2,7,12,17,22],
        [3,8,13,18,23],[4,9,14,19,24],
        [0,6,12,18,24],[4,8,12,16,20]
    ];

    if(lines.some(l => l.every(i => markedCells.includes(i)))) {
        db.ref('game/winner').set({
            id: user.id,
            name: user.first_name
        });
    } else {
        alert("ቢንጎ ገና አልሆነም!");
    }
}
</script>
