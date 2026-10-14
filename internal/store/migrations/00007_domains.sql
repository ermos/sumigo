-- +goose Up
-- Custom domains (CNAME to the instance) that open one site, and may call the API cross-origin.
CREATE TABLE domains (
    host    TEXT    PRIMARY KEY,
    site_id INTEGER NOT NULL REFERENCES sites (id) ON DELETE CASCADE
);

-- +goose Down
DROP TABLE domains;
