import express from "express";
import { query } from "../db/pool.js";
import { normalizeDigits } from "../utils/normalizeDigits.js";
import { requireRoles, requireTeacher } from "../middleware/requireTeacher.js";

export const inboxRouter = express.Router();
export const staffInboxRouter = express.Router();

inboxRouter.param("studentId", async (req, res, next, value) => {
  try {
    const code = clean(req.headers["x-student-code"]);
    const result = await query("SELECT 1 FROM students WHERE id=$1 AND is_active=TRUE AND deleted_at IS NULL AND (student_code=$2 OR student_serial=$2)", [Number(value), code]);
    req.studentAccess = result.rowCount > 0;
    next();
  } catch (error) { next(error); }
});

function clean(value) { return normalizeDigits(value).trim(); }
async function studentIdFromRequest(req) { const code=clean(req.headers["x-student-code"]); const result=await query("SELECT id FROM students WHERE is_active=TRUE AND deleted_at IS NULL AND (student_code=$1 OR student_serial=$1) LIMIT 1",[code]); return result.rows[0]?.id||null; }
function staffCanUseInbox(req) { return req.teacher?.role !== "assistant" || req.teacher?.can_use_inbox === true; }
function senderType(role) { return role === "admin" || role === "teacher" || role === "assistant" ? role : "admin"; }

async function getThread(threadId, studentId = null) {
  const result = await query(`SELECT it.*, s.full_name, s.student_serial, s.student_code,
    COALESCE(g.display_name,g.name) AS group_name, COALESCE(g.grade_level,g.grade) AS grade_level,
    (SELECT COUNT(*) FROM inbox_messages im WHERE im.thread_id=it.id AND im.is_read=FALSE) AS unread_count
    FROM inbox_threads it LEFT JOIN students s ON s.id=it.student_id LEFT JOIN groups g ON g.id=s.group_id
    WHERE it.id=$1${studentId ? " AND it.student_id=$2" : ""}`, studentId ? [threadId, studentId] : [threadId]);
  return result.rows[0] || null;
}

async function addMessage(threadId, type, senderId, body) {
  const message = await query(`INSERT INTO inbox_messages(thread_id,sender_type,sender_id,body,is_read)
    VALUES($1,$2,$3,$4,FALSE) RETURNING *`, [threadId, type, senderId, body]);
  await query("UPDATE inbox_threads SET updated_at=NOW(), status='open' WHERE id=$1", [threadId]);
  return message.rows[0];
}

async function getMessages(threadId) {
  return query(`SELECT im.*, COALESCE(ss.full_name, tt.name, tt.username, it.public_name, im.sender_type) AS sender_name
    FROM inbox_messages im
    JOIN inbox_threads it ON it.id=im.thread_id
    LEFT JOIN students ss ON im.sender_type='student' AND ss.id=im.sender_id
    LEFT JOIN teachers tt ON im.sender_type IN ('admin','teacher','assistant') AND tt.id=im.sender_id
    WHERE im.thread_id=$1 AND im.deleted_at IS NULL ORDER BY im.created_at`, [threadId]);
}

inboxRouter.get("/student/:studentId/inbox", async (req, res, next) => {
  try {
    if (!req.studentAccess) return res.status(401).json({ok:false,status:"unauthorized"});
    const studentId = Number(req.params.studentId);
    const threads = await query(`SELECT it.*, COUNT(im.id) FILTER (WHERE im.is_read=FALSE AND im.sender_type <> 'student')::int AS unread_count,
      (SELECT body FROM inbox_messages WHERE thread_id=it.id ORDER BY created_at DESC LIMIT 1) AS last_message
      FROM inbox_threads it LEFT JOIN inbox_messages im ON im.thread_id=it.id
      WHERE it.student_id=$1 GROUP BY it.id ORDER BY it.updated_at DESC`, [studentId]);
    res.json({ ok:true, threads:threads.rows, unread_count:threads.rows.reduce((sum,row)=>sum+Number(row.unread_count||0),0) });
  } catch (error) { next(error); }
});

inboxRouter.get("/student/inbox", async (req,res,next)=>{try{const studentId=await studentIdFromRequest(req);if(!studentId)return res.status(401).json({ok:false,status:"unauthorized"});const threads=await query(`SELECT it.*,(SELECT COUNT(*) FROM inbox_messages im WHERE im.thread_id=it.id AND im.deleted_at IS NULL AND im.is_read=FALSE AND im.sender_type IN ('admin','teacher','assistant'))::int AS unread_count,(SELECT body FROM inbox_messages WHERE thread_id=it.id AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1) AS last_message FROM inbox_threads it WHERE it.student_id=$1 ORDER BY it.updated_at DESC`,[studentId]);res.json({ok:true,threads:threads.rows,unread_count:threads.rows.reduce((sum,row)=>sum+Number(row.unread_count||0),0)});}catch(error){next(error);}});

inboxRouter.get("/student/:studentId/inbox/unread-count", async (req,res,next)=>{ try { if(!req.studentAccess)return res.status(401).json({ok:false,status:"unauthorized"}); const result=await query("SELECT COUNT(*)::int AS count FROM inbox_messages im JOIN inbox_threads it ON it.id=im.thread_id WHERE it.student_id=$1 AND im.is_read=FALSE AND im.sender_type <> 'student'",[Number(req.params.studentId)]); res.json({ok:true,count:result.rows[0].count}); } catch(error){next(error);} });

inboxRouter.get("/student/:studentId/inbox/:threadId/messages", async (req,res,next)=>{ try { if(!req.studentAccess)return res.status(401).json({ok:false,status:"unauthorized"}); const thread=await getThread(req.params.threadId,Number(req.params.studentId)); if(!thread)return res.status(404).json({ok:false,status:"not_found"}); await query("UPDATE inbox_messages SET is_read=TRUE WHERE thread_id=$1 AND sender_type <> 'student'",[req.params.threadId]); const messages=await getMessages(req.params.threadId); res.json({ok:true,thread,messages:messages.rows}); }catch(error){next(error);} });

inboxRouter.post("/student/:studentId/inbox", async (req,res,next)=>{ try { if(!req.studentAccess)return res.status(401).json({ok:false,status:"unauthorized"}); const studentId=Number(req.params.studentId), subject=clean(req.body?.subject), body=clean(req.body?.body); if(!studentId||!subject||!body)return res.status(400).json({ok:false,status:"invalid_message"}); const thread=await query("INSERT INTO inbox_threads(student_id,subject) VALUES($1,$2) RETURNING *",[studentId,subject]); const message=await addMessage(thread.rows[0].id,"student",studentId,body); res.status(201).json({ok:true,thread:thread.rows[0],message}); }catch(error){next(error);} });
inboxRouter.post("/student/inbox/messages", async (req,res,next)=>{try{const studentId=await studentIdFromRequest(req),subject=clean(req.body?.subject),body=clean(req.body?.body);if(!studentId)return res.status(401).json({ok:false,status:"unauthorized"});if(!subject||!body)return res.status(400).json({ok:false,status:"invalid_message"});const thread=await query("INSERT INTO inbox_threads(student_id,subject) VALUES($1,$2) RETURNING *",[studentId,subject]);const message=await addMessage(thread.rows[0].id,"student",studentId,body);res.status(201).json({ok:true,thread:thread.rows[0],message});}catch(error){next(error);}});

inboxRouter.post("/student/:studentId/inbox/:threadId/messages", async (req,res,next)=>{ try { if(!req.studentAccess)return res.status(401).json({ok:false,status:"unauthorized"}); const body=clean(req.body?.body), thread=await getThread(req.params.threadId,Number(req.params.studentId)); if(!thread)return res.status(404).json({ok:false,status:"not_found"}); if(!body)return res.status(400).json({ok:false,status:"invalid_message"}); const message=await addMessage(thread.id,"student",Number(req.params.studentId),body); res.status(201).json({ok:true,message}); }catch(error){next(error);} });
inboxRouter.put("/student/inbox/:threadId/read", async(req,res,next)=>{try{const studentId=await studentIdFromRequest(req);if(!studentId)return res.status(401).json({ok:false,status:"unauthorized"});const thread=await getThread(req.params.threadId,studentId);if(!thread)return res.status(404).json({ok:false,status:"not_found"});const result=await query("UPDATE inbox_messages SET is_read=TRUE WHERE thread_id=$1 AND deleted_at IS NULL AND is_read=FALSE AND sender_type IN ('admin','teacher','assistant') RETURNING id",[req.params.threadId]);res.json({ok:true,marked_count:result.rowCount});}catch(error){next(error);}});

staffInboxRouter.use(requireTeacher, requireRoles("admin","teacher","assistant"));
staffInboxRouter.use((req,res,next)=>staffCanUseInbox(req)?next():res.status(403).json({ok:false,status:"inbox_permission_required"}));

staffInboxRouter.get("/inbox/unread-count", async(req,res,next)=>{try{const result=await query("SELECT COUNT(*)::int AS count FROM inbox_messages WHERE deleted_at IS NULL AND is_read=FALSE AND sender_type IN ('student','public')");res.json({ok:true,count:result.rows[0].count});}catch(error){next(error);}});
staffInboxRouter.get(["/inbox","/inbox/threads"], async(req,res,next)=>{try{const values=[],filters=["1=1"];const term=clean(req.query.search);const readFilter=String(req.query.read||"");if(req.query.unread==="true"||readFilter==="unread")filters.push("EXISTS (SELECT 1 FROM inbox_messages u WHERE u.thread_id=it.id AND u.deleted_at IS NULL AND u.is_read=FALSE AND u.sender_type IN ('student','public'))");if(readFilter==="read")filters.push("NOT EXISTS (SELECT 1 FROM inbox_messages u WHERE u.thread_id=it.id AND u.deleted_at IS NULL AND u.is_read=FALSE AND u.sender_type IN ('student','public'))");if(term){values.push(`%${term}%`);const n=values.length;filters.push(`(s.full_name ILIKE $${n} OR s.student_serial ILIKE $${n} OR s.student_code ILIKE $${n} OR COALESCE(g.display_name,g.name) ILIKE $${n} OR COALESCE(g.grade_level,g.grade) ILIKE $${n} OR it.public_name ILIKE $${n} OR it.public_phone ILIKE $${n})`);}if(req.query.date){values.push(String(req.query.date));filters.push(`it.created_at >= $${values.length}::date AND it.created_at < ($${values.length}::date + INTERVAL '1 day')`);}const result=await query(`SELECT it.*,s.full_name,s.student_serial,s.student_code,COALESCE(g.display_name,g.name) AS group_name,COALESCE(g.grade_level,g.grade) AS grade_level,(SELECT COUNT(*) FROM inbox_messages u WHERE u.thread_id=it.id AND u.deleted_at IS NULL AND u.is_read=FALSE AND u.sender_type IN ('student','public'))::int AS unread_count,CASE WHEN EXISTS (SELECT 1 FROM inbox_messages u WHERE u.thread_id=it.id AND u.deleted_at IS NULL AND u.is_read=FALSE AND u.sender_type IN ('student','public')) THEN 'unread' ELSE 'read' END AS read_status,(SELECT body FROM inbox_messages WHERE thread_id=it.id AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1) AS last_message FROM inbox_threads it LEFT JOIN students s ON s.id=it.student_id LEFT JOIN groups g ON g.id=s.group_id WHERE ${filters.join(" AND ")} ORDER BY it.updated_at DESC`,values);res.json({ok:true,threads:result.rows});}catch(error){next(error);}});
async function staffThreadMessages(req,res,next){try{const thread=await getThread(req.params.id);if(!thread)return res.status(404).json({ok:false,status:"not_found"});await query("UPDATE inbox_messages SET is_read=TRUE WHERE thread_id=$1 AND sender_type IN ('student','public')",[req.params.id]);const messages=await getMessages(req.params.id);res.json({ok:true,thread,messages:messages.rows});}catch(error){next(error);}}
staffInboxRouter.get("/inbox/:id", staffThreadMessages);
staffInboxRouter.get("/inbox/threads/:id/messages", staffThreadMessages);
async function markStaffRead(req,res,next){try{const result=await query("UPDATE inbox_messages SET is_read=TRUE WHERE thread_id=$1 AND deleted_at IS NULL AND is_read=FALSE AND sender_type IN ('student','public') RETURNING id",[req.params.id]);res.json({ok:true,marked_count:result.rowCount});}catch(error){next(error);}}
staffInboxRouter.put("/inbox/:id/read", markStaffRead);
staffInboxRouter.post("/inbox/:id/read", markStaffRead);
staffInboxRouter.delete("/inbox/:threadId/messages/:messageId", requireRoles("admin"), async(req,res,next)=>{try{const result=await query("UPDATE inbox_messages SET deleted_at=NOW(), is_read=TRUE WHERE id=$1 AND thread_id=$2 AND deleted_at IS NULL RETURNING id",[Number(req.params.messageId),Number(req.params.threadId)]);if(!result.rowCount)return res.status(404).json({ok:false,status:"not_found"});await query("UPDATE inbox_threads SET updated_at=NOW() WHERE id=$1",[Number(req.params.threadId)]);await query("INSERT INTO audit_logs(action,actor_id,details) VALUES ('inbox_message_deleted',$1,$2)",[req.teacher.id,JSON.stringify({thread_id:Number(req.params.threadId),message_id:Number(req.params.messageId)})]);res.json({ok:true});}catch(error){next(error);}});
staffInboxRouter.post("/inbox/read-visible", async(req,res,next)=>{try{const ids=Array.isArray(req.body?.thread_ids)?req.body.thread_ids.map(Number).filter(Number.isInteger):[];if(!ids.length)return res.json({ok:true,marked_count:0});const result=await query("UPDATE inbox_messages SET is_read=TRUE WHERE thread_id=ANY($1::bigint[]) AND is_read=FALSE AND sender_type IN ('student','public') RETURNING id",[ids]);res.json({ok:true,marked_count:result.rowCount});}catch(error){next(error);}});
staffInboxRouter.post("/inbox/threads/:id/messages", async(req,res,next)=>{try{const body=clean(req.body?.body),thread=await getThread(req.params.id);if(!thread)return res.status(404).json({ok:false,status:"not_found"});if(!body)return res.status(400).json({ok:false,status:"invalid_message"});const message=await addMessage(thread.id,senderType(req.teacher.role),req.teacher.id,body);res.status(201).json({ok:true,message});}catch(error){next(error);}});
staffInboxRouter.post("/inbox/:id/messages", async(req,res,next)=>{try{const body=clean(req.body?.body),thread=await getThread(req.params.id);if(!thread)return res.status(404).json({ok:false,status:"not_found"});if(!body)return res.status(400).json({ok:false,status:"invalid_message"});const message=await addMessage(thread.id,senderType(req.teacher.role),req.teacher.id,body);res.status(201).json({ok:true,message});}catch(error){next(error);}});

export async function createPublicInquiry({ studentId=null, name, phone, subject, body }) {
  const thread=await query("INSERT INTO inbox_threads(student_id,public_name,public_phone,subject) VALUES($1,$2,$3,$4) RETURNING *",[studentId||null,clean(name)||null,clean(phone)||null,clean(subject)||"Public inquiry"]);
  const message=await addMessage(thread.rows[0].id,studentId?"student":"public",studentId||null,clean(body));
  return {thread:thread.rows[0],message};
}
