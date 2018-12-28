require("dotenv").config(); // tslint:disable-line no-var-requires

import { Comment, PrivateMessage, Submission } from "snoowrap";
import AntiGifBot from "./bot";
import Database from "./db";
import Ingest from "./ingest";
import Logger from "./logger";

const TAG = "Index";

async function runBot() {

    Logger.debug(TAG, "Setting up...");

    const db = new Database();
    await db.init();
    const ingest = new Ingest();
    await ingest.init();
    const bot = new AntiGifBot(db);
    await bot.init();

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
    Logger.error(TAG, "Error starting bot", err);
    process.exit(1);
});

process.on("uncaughtException", err => {
    Logger.wtf(TAG, "Uncaught Exception", err);
});

process.on("unhandledRejection", err => {
    Logger.wtf(TAG, "Unhandled Rejection", err);
});
