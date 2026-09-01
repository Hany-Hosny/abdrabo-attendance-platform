import express from "express";
import { requireTeacher } from "../middleware/requireTeacher.js";
import { requireAnyPermission } from "../services/rbac.js";
import { searchStudents } from "../services/studentSearch.js";

export const adminSearchRouter = express.Router();
adminSearchRouter.use(requireTeacher, requireAnyPermission("students.view", "payments.view", "attendance.view", "exams.view"));

adminSearchRouter.get("/", async (req, res, next) => {
  try {
    const results = await searchStudents(req.query.q, { limit: req.query.limit });
    return res.json({ ok: true, results });
  } catch (error) {
    return next(error);
  }
});
