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
    // The main tracker instance - do not delete!
    const tracker = new Tracker(db);
    const bot = new AntiGifBot(db);
    await bot.init();

    await updateIngestSourceOrder(db, ingest);
    setInterval(() => {
        updateIngestSourceOrder(db, ingest).catch(e => {
            Logger.error(TAG, "Failed to update ingest source order", e);
        });
    }, 10000).unref();

    ingest.setSubmissionCallback((submission: Submission) => {
        bot.addSubmission(submission);
    });

    ingest.setCommentCallback((comment: Comment) => {
        bot.addComment(comment);
    });

    ingest.setInboxCallback((message: PrivateMessage) => {
        bot.addInbox(message);
    });

    Logger.debug(TAG, "Starting bot and ingest...");
    await bot.start();
    await ingest.startIngest();

}

async function updateIngestSourceOrder(db: Database, ingest: Ingest) {
    const sourceOrder = await db.getIngestSourceOrder();
    ingest.setIngestSourceOrder(sourceOrder);
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
