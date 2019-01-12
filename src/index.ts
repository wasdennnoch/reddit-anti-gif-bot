require("dotenv").config(); // tslint:disable-line no-var-requires

import { Comment, PrivateMessage, Submission } from "snoowrap";
import AntiGifBot from "./bot";
import Database from "./db";
import Tracker from "./db/tracker";
import Ingest from "./ingest";
import Logger from "./logger";

const TAG = "Index";

async function runBot() {

    Logger.debug(TAG, "Setting up...");
    if (process.env.NODE_ENV !== "production") {
        Logger.warn(TAG, "Running in development mode");
    }

    const db = new Database();
    await db.init();
    const ingest = new Ingest();
    await ingest.init();
    const tracker = new Tracker(db);
    const bot = new AntiGifBot(db);
    await bot.init();

    const sourceOrder = await db.getIngestSourceOrder();
    ingest.setIngestSourceOrder(sourceOrder); // TODO refresh every now and then

    await bot.start();

    ingest.setSubmissionCallback((submission: Submission) => {
        bot.addSubmission(submission);
    });

    /*ingest.setCommentCallback((comment: Comment) => {
        bot.addComment(comment);
    });

    ingest.setInboxCallback((message: PrivateMessage) => {
        bot.addInbox(message);
    });*/

    Logger.debug(TAG, "Starting ingest...");
    await ingest.startIngest();

}

runBot().catch(err => {
    Logger.wtf(TAG, "Error starting bot", err);
});

process.on("uncaughtException", err => {
    Logger.wtf(TAG, "Uncaught Exception", err);
});

process.on("unhandledRejection", err => {
    Logger.wtf(TAG, "Unhandled Rejection", err);
});
