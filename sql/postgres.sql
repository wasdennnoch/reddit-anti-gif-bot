CREATE ROLE antigifbot WITH LOGIN PASSWORD '1234';

SHOW LC_COLLATE;

CREATE DATABASE antigifbot WITH ENCODING='UTF8' LC_COLLATE='en_US.UTF8' LC_CTYPE='en_US.UTF8';

\c antigifbot

CREATE TABLE IF NOT EXISTS gifStats (
    id               SERIAL    PRIMARY KEY,
    itemType         TEXT      NOT NULL,
    timestampCreated TIMESTAMP NOT NULL,
    timestampStart   TIMESTAMP NOT NULL,
    timestampEnd     TIMESTAMP NOT NULL,
    status           TEXT      NOT NULL,
    redditId         TEXT      NOT NULL,
    subreddit        TEXT,
    domain           TEXT      NOT NULL,
    hostname         TEXT      NOT NULL,
    gifLink          TEXT      NOT NULL,
    mp4Link          TEXT,
    mp4DisplayLink   TEXT,
    gifSize          BIGINT,
    mp4Size          BIGINT,
    webmSize         BIGINT,
    fromCache        BOOLEAN,
    uploadTime       INTEGER,
    errorCode        TEXT,
    errorDetail      TEXT,
    errorExtra       TEXT
);

GRANT CONNECT ON DATABASE antigifbot TO antigifbot;
GRANT USAGE ON SCHEMA public TO antigifbot;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO antigifbot;
GRANT SELECT, INSERT ON public.gifStats TO antigifbot;
