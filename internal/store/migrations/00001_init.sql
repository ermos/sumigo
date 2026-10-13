-- +goose Up
CREATE TABLE users (
    id            INTEGER PRIMARY KEY,
    email         TEXT    NOT NULL UNIQUE,
    name          TEXT    NOT NULL,
    password_hash TEXT    NOT NULL,
    is_admin      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE sessions (
    token_hash TEXT    PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
);

CREATE TABLE sites (
    id            INTEGER PRIMARY KEY,
    name          TEXT NOT NULL,
    repo          TEXT NOT NULL,
    branch        TEXT NOT NULL DEFAULT 'main',
    workflow      TEXT NOT NULL DEFAULT 'direct',
    media_folder  TEXT NOT NULL DEFAULT '',
    public_folder TEXT NOT NULL DEFAULT '',
    collections   TEXT NOT NULL DEFAULT '[]',
    token_enc     BLOB
);

CREATE TABLE site_access (
    site_id INTEGER NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    role    TEXT    NOT NULL,
    PRIMARY KEY (site_id, user_id)
);

-- +goose Down
DROP TABLE site_access;
DROP TABLE sites;
DROP TABLE sessions;
DROP TABLE users;
