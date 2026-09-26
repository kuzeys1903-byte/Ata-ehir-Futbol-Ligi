const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const multer = require('multer');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || __dirname;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '1907';
const SESSION_SECRET = process.env.SESSION_SECRET || 'change-this-secret-before-deploy';
const app = express();
app.set('trust proxy', 1);
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'uploads'), { recursive: true });
const db = new Database(path.join(DATA_DIR, 'league.db'));
const upload = multer({ dest: path.join(DATA_DIR, 'uploads') });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({ secret: SESSION_SECRET, resave: false, saveUninitialized: false, cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 1000*60*60*24*7 } }));
app.use('/assets', express.static(path.join(__dirname, 'logos')));
app.use('/uploads', express.static(path.join(DATA_DIR, 'uploads')));
app.use(express.static(__dirname));

function slug(s){ return s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/ı/g,'i').replace(/[^a-z0-9]+/g,'_').replace(/^_|_$/g,''); }
function logoFor(name){
  const f = slug(name)+'.png';
  return fs.existsSync(path.join(__dirname,'logos',f)) ? '/assets/'+f : null;
}

const teamNames = ['BPFK','Demospor','Kabile FK','Diriliş FK','Asist FK','Adıyaman FK','Çürük FK','Fomspor','Takata FC','Limonata FK','Ataspor','Divan-ı Hümayun SK','Ekinoks','Şizofren FK','Leğen FK','Narfex','Ördekspor','Kalamış FK','Vahşi Babunlar','Yarsenal','Ampul FC','Potalı FK','Dragos Utd','Gardenlife FC','Dinamo İstanbul','Molotof FK','Örnekgücü SK','Ataşehir UTD','Amcaspor','Şarköyspor','ZFC SK','Olimpik Limon SK'];
const fixtureData = JSON.parse(fs.readFileSync(path.join(__dirname,'fixture-data.json'),'utf8'));

function init(){
 db.exec(`CREATE TABLE IF NOT EXISTS teams(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT UNIQUE NOT NULL,logo TEXT);
 CREATE TABLE IF NOT EXISTS matches(id INTEGER PRIMARY KEY AUTOINCREMENT,week INTEGER NOT NULL,home_team_id INTEGER NOT NULL,away_team_id INTEGER NOT NULL,home_score INTEGER,away_score INTEGER,notes TEXT DEFAULT '', UNIQUE(week,home_team_id,away_team_id));
 CREATE TABLE IF NOT EXISTS playoff_matches(id INTEGER PRIMARY KEY AUTOINCREMENT,round TEXT NOT NULL,slot INTEGER NOT NULL,team1_id INTEGER,team2_id INTEGER,score1 INTEGER,score2 INTEGER,winner_id INTEGER, UNIQUE(round,slot));`);
 const count=db.prepare('SELECT COUNT(*) c FROM teams').get().c;
 if(!count){
   const ins=db.prepare('INSERT INTO teams(name,logo) VALUES(?,?)');
   const tx=db.transaction(()=>teamNames.forEach(n=>ins.run(n,logoFor(n)))); tx();
 }
 const mc=db.prepare('SELECT COUNT(*) c FROM matches').get().c;
 if(!mc){ seedMatches(); }
 seedPlayoffs();
}
function seedMatches(){
 const byName=new Map(teamNames.map(n=>[n,db.prepare('SELECT id FROM teams WHERE name=?').get(n).id]));
 const map=new Map(fixtureData.map(t=>[t.name,t.fixtures]));
 const seen=new Set(); const ins=db.prepare('INSERT OR IGNORE INTO matches(week,home_team_id,away_team_id) VALUES(?,?,?)');
 for(const t of fixtureData){
   for(const f of t.fixtures){
     if(!f.opponent) continue;
     const key=[f.week,t.name,f.opponent].sort().join('|');
     if(seen.has(key)) continue;
     seen.add(key);
     let home=t.name, away=f.opponent;
     if(f.venue==='away'){ home=f.opponent; away=t.name; }
     const hid=byName.get(home), aid=byName.get(away); if(hid&&aid) ins.run(f.week,hid,aid);
   }
 }
}
function seedPlayoffs(){
 const rounds=[['PLAYOFF',8],['ROUND OF 16',8],['QUARTERFINAL',4],['SEMIFINAL',2],['FINAL',1]];
 const ins=db.prepare('INSERT OR IGNORE INTO playoff_matches(round,slot) VALUES(?,?)');
 const tx=db.transaction(()=>rounds.forEach(([r,n])=>{for(let i=1;i<=n;i++) ins.run(r,i);})); tx();
}
init();

function admin(req,res,next){ if(req.session.admin) return next(); res.status(401).json({error:'Admin giriş gerekli'}); }

app.get('/api/teams',(req,res)=>res.json(db.prepare('SELECT id,name,logo FROM teams ORDER BY name COLLATE NOCASE').all()));
app.get('/api/matches',(req,res)=>res.json(db.prepare(`SELECT m.id,m.week,m.home_team_id,m.away_team_id,m.home_score,m.away_score,m.notes,ht.name home_name,ht.logo home_logo,at.name away_name,at.logo away_logo FROM matches m JOIN teams ht ON ht.id=m.home_team_id JOIN teams at ON at.id=m.away_team_id ORDER BY m.week,m.id`).all()));

app.get('/api/standings',(req,res)=>{
 const teams=db.prepare('SELECT id,name,logo FROM teams').all(); const stats=new Map(teams.map(t=>[t.id,{...t,played:0,win:0,draw:0,loss:0,gf:0,ga:0,gd:0,pts:0}]));
 for(const m of db.prepare('SELECT * FROM matches WHERE home_score IS NOT NULL AND away_score IS NOT NULL').all()){
   const h=stats.get(m.home_team_id), a=stats.get(m.away_team_id); if(!h||!a) continue;
   h.played++; a.played++; h.gf+=m.home_score; h.ga+=m.away_score; a.gf+=m.away_score; a.ga+=m.home_score;
   if(m.home_score>m.away_score){h.win++;a.loss++;h.pts+=3;} else if(m.home_score<m.away_score){a.win++;h.loss++;a.pts+=3;} else {h.draw++;a.draw++;h.pts++;a.pts++;}
 }
 const out=[...stats.values()].map(x=>({...x,gd:x.gf-x.ga})).sort((a,b)=>b.pts-a.pts||b.gd-a.gd||b.gf-a.gf||a.name.localeCompare(b.name,'tr')).map((x,i)=>({...x,pos:i+1,status:i<8?'DIRECT':i<24?'PLAYOFF':'OUT'}));
 res.json(out);
});

app.get('/api/playoffs',(req,res)=>{
 const rows=db.prepare(`SELECT p.*,t1.name team1_name,t1.logo team1_logo,t2.name team2_name,t2.logo team2_logo,tw.name winner_name FROM playoff_matches p LEFT JOIN teams t1 ON t1.id=p.team1_id LEFT JOIN teams t2 ON t2.id=p.team2_id LEFT JOIN teams tw ON tw.id=p.winner_id ORDER BY CASE p.round WHEN 'PLAYOFF' THEN 1 WHEN 'ROUND OF 16' THEN 2 WHEN 'QUARTERFINAL' THEN 3 WHEN 'SEMIFINAL' THEN 4 ELSE 5 END,p.slot`).all();
 res.json(rows);
});

app.get('/api/me',(req,res)=>res.json({admin:!!req.session.admin}));
app.post('/api/login',(req,res)=>{ if(req.body.password===ADMIN_PASSWORD){req.session.admin=true; return res.json({ok:true});} res.status(401).json({error:'Şifre yanlış'}); });
app.post('/api/logout',(req,res)=>req.session.destroy(()=>res.json({ok:true})));

app.put('/api/matches/:id',admin,(req,res)=>{
 const id=Number(req.params.id); const m=db.prepare('SELECT * FROM matches WHERE id=?').get(id); if(!m) return res.status(404).json({error:'Maç bulunamadı'});
 const hs=req.body.home_score===''||req.body.home_score==null?null:Number(req.body.home_score); const as=req.body.away_score===''||req.body.away_score==null?null:Number(req.body.away_score);
 if(hs!==null && (!Number.isInteger(hs)||hs<0) || as!==null && (!Number.isInteger(as)||as<0)) return res.status(400).json({error:'Geçersiz skor'});
 db.prepare('UPDATE matches SET home_score=?,away_score=?,notes=? WHERE id=?').run(hs,as,String(req.body.notes||''),id); res.json({ok:true});
});
app.put('/api/teams/:id',admin,(req,res)=>{ const id=Number(req.params.id); const name=String(req.body.name||'').trim(); if(!name) return res.status(400).json({error:'Takım adı boş olamaz'}); db.prepare('UPDATE teams SET name=? WHERE id=?').run(name,id); res.json({ok:true}); });
app.post('/api/teams/:id/logo',admin,upload.single('logo'),(req,res)=>{ if(!req.file) return res.status(400).json({error:'Dosya yok'}); const ext=path.extname(req.file.originalname).toLowerCase()||'.png'; const filename=`team_${req.params.id}_${Date.now()}${ext}`; const dest=path.join(__dirname,'uploads',filename); fs.renameSync(req.file.path,dest); const url='/uploads/'+filename; db.prepare('UPDATE teams SET logo=? WHERE id=?').run(url,Number(req.params.id)); res.json({ok:true,logo:url}); });

app.post('/api/playoffs/generate',admin,(req,res)=>{
 const standings=db.prepare('SELECT * FROM teams').all();
 // Read current order using the same calculation as the public endpoint.
 const matches=db.prepare('SELECT * FROM matches WHERE home_score IS NOT NULL AND away_score IS NOT NULL').all();
 const s=new Map(standings.map(t=>[t.id,{id:t.id,pts:0,gf:0,ga:0,gd:0}]));
 for(const m of matches){const h=s.get(m.home_team_id),a=s.get(m.away_team_id);h.gf+=m.home_score;h.ga+=m.away_score;a.gf+=m.away_score;a.ga+=m.home_score;if(m.home_score>m.away_score)h.pts+=3;else if(m.home_score<m.away_score)a.pts+=3;else{h.pts++;a.pts++;}}
 const order=[...s.values()].map(x=>({...x,gd:x.gf-x.ga})).sort((a,b)=>b.pts-a.pts||b.gd-a.gd||b.gf-a.gf);
 const ids=order.map(x=>x.id); const pairs=[]; for(let i=0;i<8;i++) pairs.push([ids[8+i],ids[23-i]]);
 const upd=db.prepare('UPDATE playoff_matches SET team1_id=?,team2_id=? WHERE round=? AND slot=?');
 const tx=db.transaction(()=>{pairs.forEach((p,i)=>upd.run(p[0],p[1],'PLAYOFF',i+1)); for(let i=1;i<=8;i++) upd.run(null,null,'ROUND OF 16',i);}); tx(); res.json({ok:true});
});

app.put('/api/playoffs/:round/:slot',admin,(req,res)=>{ const {round,slot}=req.params; const p=db.prepare('SELECT * FROM playoff_matches WHERE round=? AND slot=?').get(round,Number(slot)); if(!p) return res.status(404).json({error:'Tur bulunamadı'}); db.prepare('UPDATE playoff_matches SET score1=?,score2=?,winner_id=? WHERE id=?').run(req.body.score1===''?null:Number(req.body.score1),req.body.score2===''?null:Number(req.body.score2),req.body.winner_id?Number(req.body.winner_id):null,p.id); res.json({ok:true}); });

app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'index.html')));
app.listen(PORT,()=>console.log(`Ataşehir Futbol Ligi: http://localhost:${PORT}`));
