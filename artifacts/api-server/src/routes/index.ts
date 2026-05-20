import { Router, type IRouter } from "express";
import healthRouter from "./health";
import paymentRouter from "./payment";
import botRouter from "./bot";

const router: IRouter = Router();

router.use(healthRouter);
router.use(paymentRouter);
router.use(botRouter);

export default router;
