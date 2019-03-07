CREATE ROLE antigifbot WITH LOGIN PASSWORD '1234';

SHOW LC_COLLATE;

CREATE DATABASE antigifbot WITH ENCODING='UTF8' LC_COLLATE='en_US.UTF8' LC_CTYPE='en_US.UTF8';

\c antigifbot

CREATE TABLE IF NOT EXISTS gifStats (
    id                  SERIAL      PRIMARY KEY,
    itemType            TEXT        NOT NULL,
    createdAt           TIMESTAMP   NOT NULL,
    startedAt           TIMESTAMP   NOT NULL,
    endedAt             TIMESTAMP   NOT NULL,
    status              TEXT        NOT NULL,
    redditId            TEXT        NOT NULL,
    subreddit           TEXT,
    domain              TEXT        NOT NULL,
    hostname            TEXT        NOT NULL,
    gifLink             TEXT        NOT NULL,
    mp4Link             TEXT,
    mp4DisplayLink      TEXT,
    gifSize             BIGINT,
    mp4Size             BIGINT,
    webmSize            BIGINT,
    fromCache           BOOLEAN,
    uploadTime          INTEGER,
    errorCode           TEXT,
    errorDetail         TEXT,
    errorExtra          TEXT
);

CREATE TABLE IF NOT EXISTS exceptions (
    id                  SERIAL      PRIMARY KEY,
    type                TEXT        NOT NULL,
    location            TEXT        NOT NULL,
    source              TEXT        NOT NULL,
    reason              TEXT,
    createdAt           TIMESTAMP   NOT NULL,
    endsAt              TIMESTAMP,
    duration            INTEGER
);

CREATE TABLE IF NOT EXISTS settings (
    id                  SERIAL      PRIMARY KEY,
    key                 TEXT        NOT NULL,
    key2                TEXT,
    value               TEXT        NOT NULL
);

CREATE TABLE IF NOT EXISTS redditStats (
    id                  SERIAL      PRIMARY KEY,
    createdAt           TIMESTAMP   NOT NULL        DEFAULT now(),
    key                 TEXT        NOT NULL,
    key2                TEXT,
    value               INTEGER     NOT NULL
);

CREATE INDEX locationIndex ON exceptions (lower(location));
CREATE INDEX createdAtIndex ON redditStats (createdAt ASC);

GRANT CONNECT ON DATABASE antigifbot TO antigifbot;
GRANT USAGE ON SCHEMA public TO antigifbot;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO antigifbot;
GRANT SELECT, INSERT ON public.gifStats TO antigifbot;
GRANT SELECT, INSERT ON public.exceptions TO antigifbot;
GRANT SELECT, INSERT ON public.settings TO antigifbot;
