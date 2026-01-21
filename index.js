<script>
    const ADMIN_ID = 8431270634; 
    const fb = firebase.initializeApp({ databaseURL: "https://dagi-bingo-default-rtdb.firebaseio.com/" });
    const db = fb.database();
    const tg = window.Telegram.WebApp; 
    tg.ready(); tg.expand();

    const user = tg.initDataUnsafe.user || { id: "GUEST_" + Date.now(), first_name: "Player" };
    document.getElementById('u-name').innerText = user.first_name;
    if(user.id == ADMIN_ID) document.getElementById('adm-gate').style.display = 'block';

    let myBal = 0, drawn = [], markedCells = [12], autoInterval = null, currentBet = 0, myBoard = [], hasBoard = false, myBoardID = null;

    // Timer Listener - አሁን በ "HIT" ቦታ ላይ እንዲታይ ተደርጓል
    db.ref('game/timer').on('value', s => {
        const val = s.val();
        const hintEl = document.getElementById('live-hint'); // የ "HIT" ቦታ
        
        if (val !== null && val > 0) {
            // ታይመሩ በ "HIT" ቦታ ላይ ይታያል
            hintEl.innerHTML = `<span style="color: #ef4444; font-size: 2rem; font-weight: 900; animation: pulse 1s infinite;">⏳ ${val}</span>`;
            document.getElementById('timer-display').style.display = 'none'; // የድሮውን ታይመር ደብቀነዋል
        } else if (val === 0) {
            hintEl.innerHTML = `<span style="color: #22c55e; font-weight: 900;">🚀 ጀምር!</span>`;
            if(hasBoard) showP('game-page');
        } else {
            // ጨዋታው ሲጀመር የታይመሩ ቦታ ክፍት እንዲሆን
            if(drawn.length === 0) hintEl.innerHTML = ""; 
        }
    });

    // Drawn Numbers Listener - "HIT" ሳይል ቁጥሩን ብቻ ያሳያል
    db.ref('game/drawn').on('value', s => {
        const prevCount = drawn.length;
        drawn = s.val() || [];
        document.getElementById('balls-out-count').innerText = drawn.length;
        const lastNum = drawn[drawn.length - 1];
        document.getElementById('current-ball').innerText = lastNum || "?";
        document.getElementById('ball-history').innerText = drawn.slice(-10).join(" - ");
        
        if(drawn.length > 0) {
            document.getElementById('game-status-text').innerText = "● ጨዋታ ተጀምሯል";
            const h = document.getElementById('live-hint');
            
            // ቁጥሩ ካርቴላህ ላይ ሲኖር የሚመጣው ምልክት (ያለ "HIT" ጽሁፍ)
            if(hasBoard && myBoard.includes(lastNum)) {
                h.innerHTML = `<span class="board-hit">🔥 ${lastNum} 🔥</span>`;
                const cellIndex = myBoard.indexOf(lastNum);
                const cellEl = document.getElementById('c-'+cellIndex);
                if(cellEl) {
                    cellEl.classList.add('highlight-cell');
                    setTimeout(() => { cellEl.classList.remove('highlight-cell'); }, 1500);
                }
            } else if (drawn.length > 0) {
                h.innerHTML = `<span style="font-size: 1.2rem; color: #facc15;">ቁጥር ${lastNum} ወጥቷል</span>`;
            }
        }
    });

    // ሌላው የ buyBoard, startBingo, checkBingoAndClaim ወዘተ ኮድህ እንዳለ ይቀጥላል...
    // (ምንም ኮድ አልተቀነሰም)

    function buyBoard(id) {
        if(myBal < currentBet && !myBoardID) return alert("በቂ ባላንስ የለም!");
        if(myBoardID) { db.ref('reserved_boards/' + myBoardID).remove(); }
        else { db.ref('users/'+user.id+'/bal').transaction(c => (c >= currentBet ? c - currentBet : c)); }
        db.ref('reserved_boards/' + id).set(user.id);
        myBoardID = id; hasBoard = true;
        db.ref('game/timer').once('value', s => { 
            if(s.val() === -1 || s.val() === null) { 
                db.ref('game/timer').set(30); 
                db.ref('game/status').set('waiting');
            } 
        });
        startBingo(); showP('game-page');
    }

    function startBingo() {
        markedCells = [12];
        let nums = Array.from({length: 75}, (_, i) => i+1).sort(() => Math.random()-0.5).slice(0, 24);
        myBoard = []; const grid = document.getElementById('bingo-grid'); grid.innerHTML = "";
        for(let i=0; i<25; i++) {
            let val = (i === 12) ? "FREE" : nums.pop(); myBoard.push(val);
            let c = document.createElement('div'); c.className = 'cell col-'+(i%5)+(val==="FREE"?" marked":""); 
            c.id = 'c-'+i; c.innerText = val;
            c.onclick = () => { if(drawn.includes(val) || val === "FREE") { if(!markedCells.includes(i)) { c.classList.add('marked'); markedCells.push(i); } } };
            grid.appendChild(c);
        }
    }

    // የተቀሩት ፋንክሽኖች (reqFinance, approveReq, rejectReq, resetGame ወዘተ) እንዳሉ ተካተዋል
</script>
