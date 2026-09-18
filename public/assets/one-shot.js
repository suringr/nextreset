/**
 * ONE SHOT // 80 CONTRACTS — the game at /play/.
 *
 * Between the two markers below is the approved prototype's script, character for character, with the
 * owner's approved edits applied and nothing else. `one-shot.test.ts` rebuilds that section from the
 * prototype (kept in the test fixtures) and the edit list in `one-shot-approved.ts`, and fails on any
 * other difference, so the game cannot drift by accident and every deviation is named in one place:
 *
 *   - progress is kept in `nextreset.player.v1` — the five places the prototype used its own keys;
 *   - RELOAD takes its contract's reload time and keeps the crowd and the clock;
 *   - no screen shake for a visitor who has asked for reduced motion.
 *
 * Above the first marker is the small adapter those edits call. It is the only code here that the
 * prototype did not have.
 */
(function () {
    var player = window.NextResetPlayer || null;
    var calm = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };

    // Where player.js could not load at all, the game still runs; its progress then lasts as long as the
    // page, which is what the prototype would have done with storage switched off, minus the crash.
    var memory = { unlocked: 1, xp: 0, stars: {}, bestScore: 0 };

    var progress = {
        unlocked: function () { return player ? player.oneShot().unlocked : memory.unlocked; },
        xp: function () { return player ? player.oneShot().xp : memory.xp; },
        stars: function (contract) { return player ? player.oneShot().stars[contract - 1] : (memory.stars[contract] || 0); },
        clear: function (contract, points, stars) {
            if (player) {
                player.recordContract(contract, points, stars);
                // The header's chip is the site's view of the same XP; it follows the clear at once.
                player.paintChip();
                return;
            }
            memory.stars[contract] = Math.max(memory.stars[contract] || 0, stars);
            memory.xp += points;
            memory.unlocked = Math.max(memory.unlocked, Math.min(80, contract + 1));
        },
        finish: function (score) {
            if (player) player.recordFinish(score);
            else memory.bestScore = Math.max(memory.bestScore, score);
        }
    };

// ---- the approved prototype, from here to the end marker ----
const c=document.querySelector('#game'),ctx=c.getContext('2d'),fireBtn=document.querySelector('#fire'),bestEl=document.querySelector('#best');
let W=0,H=0,D=1,last=0,started=performance.now(),score=0,combo=1,shot=false,state='play',message='',msgUntil=0,mission=Math.max(0,Math.min(79,(+progress.unlocked()||1)-1)),shake=0,ammo=1,maxAmmo=1,reloading=false,reloadEnd=0,attempt=1,levelScore=0;
const ranks=['Recruit','Rookie','Marksman','Sharpshooter','Hunter','Operative','Elite','Ghost','Master Sniper'];
let aim={x:500,y:300}, enemies=[], civilians=[];
const chapters=['ROOKIE','RELOAD','HUNTER','UNDER FIRE','PRECISION','PRESSURE','ELITE','MASTER'];
const missions=Array.from({length:80},(_,i)=>{let L=i+1,ch=Math.floor(i/10);return {title:`${chapters[ch]} • CONTRACT ${L}`,desc:L<11?'Find the red-case courier.':L<31?'Track the moving target. Reload when empty.':L<41?'Find the armed hostile before he fires.':L<61?'Precision under pressure.':L<71?'Elite contract: faster targets.':'Master contract: survive and clear the threat.',time:Math.max(11,20-Math.floor(L/12)),n:Math.min(11,5+Math.floor(L/10)),type:L<31?'courier':'gunman',level:L,ammo:L<11?1:(L<41?3:4),reload:L<11?0:Math.max(900,1800-L*10),reaction:Math.max(2600,7000-L*45)};});
function resize(){
 const r=c.getBoundingClientRect(); D=Math.min(devicePixelRatio||1,2); W=r.width;H=r.height;c.width=W*D;c.height=H*D;ctx.setTransform(D,0,0,D,0,0);
 if(!aim.x||aim.x>W) aim={x:W*.55,y:H*.5}; if(state==='play') spawn(false);
}
addEventListener('resize',resize);
function spawn(resetClock=true){enemies=[];civilians=[];shot=false;state='play';message='';levelScore=0;let m=missions[mission];maxAmmo=m.ammo;ammo=maxAmmo;reloading=false;if(resetClock)started=performance.now();let ground=H*.72;for(let i=0;i<m.n;i++){let p={x:W*(.12+Math.random()*.76),y:ground+(Math.random()-.5)*34,vx:(Math.random()<.5?-1:1)*(26+m.level*.8+Math.random()*30),phase:Math.random()*10,hat:Math.random()<.25,phone:Math.random()<.3,case:false,armed:false,hostile:false,aiming:false,fireAt:0,dead:false};civilians.push(p)}let t=civilians[Math.floor(Math.random()*civilians.length)];t.hostile=true;if(m.type==='courier')t.case=true;else{t.armed=true;t.fireAt=started+m.reaction+Math.random()*2500}enemies=[t]}
function panel(x,y,w,h){ctx.fillStyle='rgba(5,14,22,.88)';ctx.beginPath();ctx.roundRect(x,y,w,h,11);ctx.fill()}
function background(){
 let g=ctx.createLinearGradient(0,0,0,H);g.addColorStop(0,'#625e72');g.addColorStop(.52,'#d28379');g.addColorStop(1,'#172630');ctx.fillStyle=g;ctx.fillRect(0,0,W,H);
 ctx.fillStyle='#253744';for(let i=0;i<16;i++){let bw=W/13+12,bh=60+(i*43%Math.max(100,H*.3));ctx.fillRect(i*W/15-30,H*.62-bh,bw,bh)}
 ctx.fillStyle='#0e1922';ctx.fillRect(0,H*.69,W,H*.31);ctx.fillStyle='#263945';ctx.fillRect(0,H*.685,W,8);
 ctx.strokeStyle='#344b59';ctx.lineWidth=4;ctx.beginPath();ctx.moveTo(0,H*.62);ctx.lineTo(W,H*.62);ctx.stroke();
}
function update(dt,now){
 if(state!=='play')return; let m=missions[mission];if(reloading&&now>=reloadEnd){reloading=false;ammo=maxAmmo;}
 for(const p of civilians){if(p.dead)continue;p.x+=p.vx*dt;p.y+=Math.sin(now/550+p.phase)*dt*8;if(p.x<45){p.x=45;p.vx=Math.abs(p.vx)}if(p.x>W-45){p.x=W-45;p.vx=-Math.abs(p.vx)}
   if(p.armed&&p.hostile){let until=p.fireAt-now;if(until<2600){p.aiming=true;p.vx*=Math.pow(.03,dt)}
      if(until<=0){state='lost';message='YOU WERE SHOT';shake=18;msgUntil=now+1700;}}
 }
 let left=m.time-(now-started)/1000;if(left<=0){state='lost';message='TIME UP';msgUntil=now+1400}
}
function drawPerson(p,now){
 if(p.dead)return;ctx.save();ctx.translate(p.x,p.y);let walk=Math.sin(now/130+p.phase)*8;
 ctx.fillStyle='#081018';ctx.strokeStyle='#081018';ctx.lineCap='round';ctx.lineWidth=7;ctx.beginPath();ctx.arc(0,-58,10,0,Math.PI*2);ctx.fill();
 ctx.beginPath();ctx.moveTo(0,-47);ctx.lineTo(0,-13);ctx.moveTo(0,-36);ctx.lineTo(-14,-19+walk*.2);
 if(p.armed&&p.aiming){ctx.moveTo(0,-35);ctx.lineTo(17,-38);ctx.lineTo(31,-38)}else{ctx.moveTo(0,-35);ctx.lineTo(15,-18-walk*.2)}
 ctx.moveTo(0,-13);ctx.lineTo(-12+walk,18);ctx.moveTo(0,-13);ctx.lineTo(12-walk,18);ctx.stroke();
 if(p.hat){ctx.fillRect(-14,-70,28,4);ctx.fillRect(-9,-79,18,10)}
 if(p.phone){ctx.fillStyle='#70dcff';ctx.fillRect(-18,-28,5,9)}
 if(p.case){ctx.fillStyle='#d63737';ctx.fillRect(10,-9,21,17);ctx.strokeStyle='#d63737';ctx.lineWidth=3;ctx.strokeRect(15,-15,11,7)}
 if(p.armed&&p.aiming){ctx.fillStyle='#1b242a';ctx.fillRect(24,-42,23,6);ctx.fillRect(29,-36,5,8);ctx.fillStyle='#ef4a4f';ctx.beginPath();ctx.arc(48,-39,3,0,7);ctx.fill()}
 ctx.restore();
}
function scope(){
 let r=Math.min(W,H)*(W<700?.27:.29);r=Math.max(92,Math.min(r,270));
 ctx.save();ctx.strokeStyle='#020608';ctx.lineWidth=W<700?9:13;ctx.beginPath();ctx.arc(aim.x,aim.y,r,0,7);ctx.stroke();
 ctx.strokeStyle='rgba(0,0,0,.9)';ctx.lineWidth=3;ctx.beginPath();ctx.moveTo(aim.x-r,aim.y);ctx.lineTo(aim.x+r,aim.y);ctx.moveTo(aim.x,aim.y-r);ctx.lineTo(aim.x,aim.y+r);ctx.stroke();
 for(let i=-3;i<=3;i++){ctx.beginPath();ctx.moveTo(aim.x+i*28,aim.y-6);ctx.lineTo(aim.x+i*28,aim.y+6);ctx.stroke()}
 ctx.fillStyle='#f0444b';ctx.beginPath();ctx.arc(aim.x,aim.y,4,0,7);ctx.fill();ctx.restore();
}
function ui(now){
 const m=missions[mission],mobile=W<700,pw=Math.min(mobile?W-24:430,W-24);
 panel(12,12,pw,mobile?102:118);ctx.fillStyle='#9fb0bd';ctx.font='700 13px system-ui';ctx.fillText(`LEVEL ${mission+1} / 80 • ${m.title}`,26,36);
 ctx.fillStyle='#fff';ctx.font=`800 ${mobile?18:23}px system-ui`;ctx.fillText(m.type==='gunman'?'ELIMINATE THE ARMED THREAT':'IDENTIFY THE COURIER',26,62);ctx.fillStyle='#b7c5cf';ctx.font=`${mobile?12:14}px system-ui`;
 let d=m.desc+` • Ammo ${ammo}/${maxAmmo}`; if(mobile&&d.length>50)d=d.slice(0,47)+'…';ctx.fillText(d,26,87);
 let left=Math.max(0,m.time-(now-started)/1000); if(m.type==='gunman'&&enemies[0]&&!enemies[0].dead){let threat=Math.max(0,(enemies[0].fireAt-now)/1000);ctx.fillStyle=threat<3?'#ff6065':'#ffd36b';ctx.fillText(`HOSTILE FIRES IN ${threat.toFixed(1)}s`,26,mobile?108:112)}
 let bw=mobile?170:245,bx=W-bw-12,by=mobile?122:12;panel(bx,by,bw,58);ctx.fillStyle='#fff';ctx.font=`800 ${mobile?16:20}px system-ui`;ctx.fillText(`⏱ ${left.toFixed(1)}   ★ ${score}`,bx+14,by+36);
}
function overlay(now){
 if(!message)return;ctx.fillStyle='rgba(2,7,11,.67)';ctx.fillRect(0,0,W,H);ctx.textAlign='center';ctx.fillStyle=state==='won'?'#72e6a5':'#ff646a';ctx.font=`900 ${Math.min(48,W/8)}px system-ui`;ctx.fillText(message,W/2,H/2);ctx.textAlign='left';
 if(state!=='play'&&now>msgUntil){if(state==='won'){if(mission===79){progress.finish(score);mission=0;score=0;combo=1}else mission++;attempt=1;spawn()}else{combo=1;spawn()}}
}
function frame(now){
 let dt=Math.min(.035,(now-last)/1000||0);last=now;update(dt,now);ctx.save();if(shake){if(!calm.matches)ctx.translate((Math.random()-.5)*shake,(Math.random()-.5)*shake);shake*=.86}background();civilians.forEach(p=>drawPerson(p,now));scope();ui(now);overlay(now);ctx.restore();let xp=+progress.xp()||0,rank=ranks[Math.min(8,Math.floor(xp/8000))],st=+progress.stars(mission+1)||0;bestEl.textContent=`${rank} • XP ${xp} • L${mission+1}/80 ${'★'.repeat(st)}`;fireBtn.textContent=reloading?'LOAD':(ammo?'FIRE':'RELOAD');requestAnimationFrame(frame)
}
function reload(){let m=missions[mission];if(state!=='play'||reloading||ammo===maxAmmo||!m.reload)return;reloading=true;reloadEnd=performance.now()+m.reload;message='RELOADING';setTimeout(()=>{if(reloading&&message==='RELOADING')message=''},500)}
function shoot(){if(state!=='play'||reloading)return;if(ammo<=0){reload();return}ammo--;shake=7;let hit=null,dist=1e9;for(const p of civilians){if(p.dead)continue;let d=Math.hypot(aim.x-p.x,aim.y-(p.y-35));if(d<dist){dist=d;hit=p}}let radius=W<700?32:36;if(hit&&dist<radius&&hit.hostile){hit.dead=true;let head=Math.hypot(aim.x-hit.x,aim.y-(hit.y-58))<14,left=Math.max(0,missions[mission].time-(performance.now()-started)/1000),pts=Math.round((500+left*35+(head?300:0))*combo*(attempt===1?1:attempt===2?.8:.6));score+=pts;levelScore+=pts;combo++;state='won';message=head?'HEADSHOT • CLEAR':'MISSION CLEAR';msgUntil=performance.now()+1100;let stars=pts>1050?3:pts>750?2:1;progress.clear(mission+1,pts,stars);}else if(hit&&dist<radius){score=Math.max(0,score-750);combo=1;attempt++;state='lost';message='CIVILIAN HIT • -750';msgUntil=performance.now()+1300}else{score=Math.max(0,score-150);combo=1;if(ammo===0&&maxAmmo===1){attempt++;state='lost';message='MISSED • -150';msgUntil=performance.now()+1100}}}
function pointer(e){const r=c.getBoundingClientRect(),q=e.touches?e.touches[0]:e;aim.x=Math.max(0,Math.min(W,q.clientX-r.left));aim.y=Math.max(0,Math.min(H,q.clientY-r.top))}
c.addEventListener('pointermove',pointer);c.addEventListener('pointerdown',e=>{pointer(e);if(e.pointerType==='mouse'&&e.button===0)shoot()});
c.addEventListener('touchstart',e=>{pointer(e);e.preventDefault()},{passive:false});c.addEventListener('touchmove',e=>{pointer(e);e.preventDefault()},{passive:false});
fireBtn.addEventListener('pointerdown',e=>{e.preventDefault();ammo?shoot():reload()});addEventListener('keydown',e=>{if(e.code==='Space'){e.preventDefault();shoot()}if(e.key.toLowerCase()==='r')reload();if(e.key.toLowerCase()==='n'){let u=+progress.unlocked()||1,v=+prompt('Choose unlocked level 1-'+u,mission+1);if(v>=1&&v<=u){mission=v-1;attempt=1;spawn()}}});
resize();spawn();requestAnimationFrame(frame);
// ---- end of the approved prototype ----
})();
