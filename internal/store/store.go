// Package store persists users, sessions, sites and access rights in SQLite.
package store

import (
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"time"

	"github.com/pressly/goose/v3"
	"golang.org/x/crypto/bcrypt"
	_ "modernc.org/sqlite"
)

//go:embed migrations/*.sql
var migrations embed.FS

var ErrNotFound = errors.New("not found")

// Roles on a site, ordered by power.
const (
	RoleViewer    = "viewer"
	RoleEditor    = "editor"
	RolePublisher = "publisher"
)

var roleRank = map[string]int{RoleViewer: 1, RoleEditor: 2, RolePublisher: 3}

// RoleAtLeast reports whether role grants at least min.
func RoleAtLeast(role, min string) bool { return roleRank[role] >= roleRank[min] }

type User struct {
	ID           int64  `json:"id"`
	Email        string `json:"email"`
	Name         string `json:"name"`
	IsAdmin      bool   `json:"is_admin"`
	PasswordHash string `json:"-"`
}

type Site struct {
	ID   int64  `json:"id"`
	Name string `json:"name"`
	Repo string `json:"repo"`
	// Forge is github, gitlab or gitea (Gitea and Forgejo); ForgeURL its instance, empty for github.com and gitlab.com.
	Forge    string `json:"forge"`
	ForgeURL string `json:"forge_url"`
	Branch   string `json:"branch"`
	Workflow string `json:"workflow"`
	HasToken bool   `json:"has_token"`
	// AIEnabled turns the AI assistant on for this site, when it is also set up instance-wide.
	AIEnabled bool   `json:"ai_enabled"`
	Role      string `json:"role,omitempty"`
	// Token is write-only: accepted on save, never read back.
	Token string `json:"token,omitempty"`
}

type Access struct {
	UserID int64  `json:"user_id"`
	Role   string `json:"role"`
}

type Store struct {
	db  *sql.DB
	gcm cipher.AEAD
}

// Open opens the SQLite database and applies migrations. secret encrypts GitHub tokens at rest.
func Open(path, secret string) (*Store, error) {
	db, err := sql.Open("sqlite", "file:"+path+"?_pragma=foreign_keys(1)&_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)")
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	goose.SetBaseFS(migrations)
	goose.SetLogger(goose.NopLogger())
	if err := goose.SetDialect("sqlite3"); err != nil {
		return nil, err
	}
	if err := goose.Up(db, "migrations"); err != nil {
		return nil, err
	}
	gcm, err := newGCM(secret)
	if err != nil {
		return nil, err
	}
	return &Store{db: db, gcm: gcm}, nil
}

func (s *Store) Close() error { return s.db.Close() }

// --- users

func (s *Store) CountUsers() (n int, err error) {
	err = s.db.QueryRow(`SELECT COUNT(*) FROM users`).Scan(&n)
	return
}

func (s *Store) CreateUser(u *User, password string) error {
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return err
	}
	res, err := s.db.Exec(`INSERT INTO users (email, name, password_hash, is_admin) VALUES (?, ?, ?, ?)`,
		u.Email, u.Name, string(hash), u.IsAdmin)
	if err != nil {
		return err
	}
	u.ID, err = res.LastInsertId()
	return err
}

// UpdateUser updates profile fields, and the password when non-empty.
func (s *Store) UpdateUser(u *User, password string) error {
	if _, err := s.db.Exec(`UPDATE users SET email = ?, name = ?, is_admin = ? WHERE id = ?`,
		u.Email, u.Name, u.IsAdmin, u.ID); err != nil {
		return err
	}
	if password == "" {
		return nil
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return err
	}
	_, err = s.db.Exec(`UPDATE users SET password_hash = ? WHERE id = ?`, string(hash), u.ID)
	return err
}

func (s *Store) DeleteUser(id int64) error {
	_, err := s.db.Exec(`DELETE FROM users WHERE id = ?`, id)
	return err
}

func (s *Store) ListUsers() ([]User, error) {
	rows, err := s.db.Query(`SELECT id, email, name, is_admin, password_hash FROM users ORDER BY name`)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	users := []User{}
	for rows.Next() {
		var u User
		if err := rows.Scan(&u.ID, &u.Email, &u.Name, &u.IsAdmin, &u.PasswordHash); err != nil {
			return nil, err
		}
		users = append(users, u)
	}
	return users, rows.Err()
}

func (s *Store) userWhere(where string, arg any) (*User, error) {
	var u User
	err := s.db.QueryRow(`SELECT id, email, name, is_admin, password_hash FROM users WHERE `+where, arg).
		Scan(&u.ID, &u.Email, &u.Name, &u.IsAdmin, &u.PasswordHash)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	return &u, err
}

func (s *Store) UserByID(id int64) (*User, error) { return s.userWhere("id = ?", id) }

// Authenticate returns the user matching email and password.
func (s *Store) Authenticate(email, password string) (*User, error) {
	u, err := s.userWhere("email = ?", email)
	if err != nil {
		return nil, err
	}
	if bcrypt.CompareHashAndPassword([]byte(u.PasswordHash), []byte(password)) != nil {
		return nil, ErrNotFound
	}
	return u, nil
}

// --- sessions (only the token hash is stored)

func hashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

func (s *Store) CreateSession(userID int64, ttl time.Duration) (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	token := hex.EncodeToString(b)
	_, err := s.db.Exec(`INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)`,
		hashToken(token), userID, time.Now().Add(ttl).Unix())
	return token, err
}

func (s *Store) UserBySession(token string) (*User, error) {
	var id int64
	err := s.db.QueryRow(`SELECT user_id FROM sessions WHERE token_hash = ? AND expires_at > ?`,
		hashToken(token), time.Now().Unix()).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return s.UserByID(id)
}

func (s *Store) DeleteSession(token string) error {
	_, err := s.db.Exec(`DELETE FROM sessions WHERE token_hash = ? OR expires_at <= ?`, hashToken(token), time.Now().Unix())
	return err
}

// --- sites

const siteCols = `s.id, s.name, s.repo, s.forge, s.forge_url, s.branch, s.workflow, s.token_enc IS NOT NULL, s.ai_enabled`

func scanSite(row interface{ Scan(...any) error }, extra ...any) (*Site, error) {
	var st Site
	dest := append([]any{&st.ID, &st.Name, &st.Repo, &st.Forge, &st.ForgeURL, &st.Branch, &st.Workflow, &st.HasToken, &st.AIEnabled}, extra...)
	if err := row.Scan(dest...); errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	} else if err != nil {
		return nil, err
	}
	return &st, nil
}

// ListSites returns the sites visible to the user, with the user's role on each.
func (s *Store) ListSites(u *User) ([]Site, error) {
	rows, err := s.db.Query(`SELECT `+siteCols+`, COALESCE(a.role, '') FROM sites s
		LEFT JOIN site_access a ON a.site_id = s.id AND a.user_id = ?
		WHERE ? OR a.role IS NOT NULL ORDER BY s.name`, u.ID, u.IsAdmin)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	sites := []Site{}
	for rows.Next() {
		var role string
		st, err := scanSite(rows, &role)
		if err != nil {
			return nil, err
		}
		st.Role = role
		if u.IsAdmin {
			st.Role = RolePublisher
		}
		sites = append(sites, *st)
	}
	return sites, rows.Err()
}

func (s *Store) GetSite(id int64) (*Site, error) {
	return scanSite(s.db.QueryRow(`SELECT `+siteCols+` FROM sites s WHERE s.id = ?`, id))
}

// SaveSite inserts or updates a site. The token is only replaced when non-empty.
func (s *Store) SaveSite(st *Site) error {
	if st.ID == 0 {
		res, err := s.db.Exec(`INSERT INTO sites (name, repo, forge, forge_url, branch, workflow, ai_enabled) VALUES (?, ?, ?, ?, ?, ?, ?)`,
			st.Name, st.Repo, st.Forge, st.ForgeURL, st.Branch, st.Workflow, st.AIEnabled)
		if err != nil {
			return err
		}
		if st.ID, err = res.LastInsertId(); err != nil {
			return err
		}
	} else if _, err := s.db.Exec(`UPDATE sites SET name = ?, repo = ?, forge = ?, forge_url = ?, branch = ?, workflow = ?, ai_enabled = ? WHERE id = ?`,
		st.Name, st.Repo, st.Forge, st.ForgeURL, st.Branch, st.Workflow, st.AIEnabled, st.ID); err != nil {
		return err
	}
	if st.Token != "" {
		enc, err := s.encrypt(st.Token)
		if err != nil {
			return err
		}
		if _, err := s.db.Exec(`UPDATE sites SET token_enc = ? WHERE id = ?`, enc, st.ID); err != nil {
			return err
		}
		st.HasToken = true
	}
	st.Token = ""
	return nil
}

func (s *Store) DeleteSite(id int64) error {
	_, err := s.db.Exec(`DELETE FROM sites WHERE id = ?`, id)
	return err
}

// SiteToken returns the decrypted GitHub token of a site.
func (s *Store) SiteToken(id int64) (string, error) {
	var enc []byte
	err := s.db.QueryRow(`SELECT token_enc FROM sites WHERE id = ?`, id).Scan(&enc)
	if errors.Is(err, sql.ErrNoRows) || (err == nil && enc == nil) {
		return "", ErrNotFound
	}
	if err != nil {
		return "", err
	}
	return s.decrypt(enc)
}

// --- access

// Role returns the user's role on a site, "" when none. Admins are publishers everywhere.
func (s *Store) Role(u *User, siteID int64) (string, error) {
	if u.IsAdmin {
		return RolePublisher, nil
	}
	var role string
	err := s.db.QueryRow(`SELECT role FROM site_access WHERE site_id = ? AND user_id = ?`, siteID, u.ID).Scan(&role)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return role, err
}

func (s *Store) ListAccess(siteID int64) ([]Access, error) {
	rows, err := s.db.Query(`SELECT user_id, role FROM site_access WHERE site_id = ?`, siteID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	list := []Access{}
	for rows.Next() {
		var a Access
		if err := rows.Scan(&a.UserID, &a.Role); err != nil {
			return nil, err
		}
		list = append(list, a)
	}
	return list, rows.Err()
}

// SetAccess replaces the whole access list of a site.
func (s *Store) SetAccess(siteID int64, list []Access) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.Exec(`DELETE FROM site_access WHERE site_id = ?`, siteID); err != nil {
		return err
	}
	for _, a := range list {
		if roleRank[a.Role] == 0 {
			return errors.New("invalid role: " + a.Role)
		}
		if _, err := tx.Exec(`INSERT INTO site_access (site_id, user_id, role) VALUES (?, ?, ?)`, siteID, a.UserID, a.Role); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// --- scheduled publishing

type Schedule struct {
	SiteID     int64
	PullNumber int
	PublishAt  time.Time
	UserID     int64
}

// SetSchedule plans (or moves) the publication of a draft pull request.
func (s *Store) SetSchedule(sc Schedule) error {
	_, err := s.db.Exec(`INSERT INTO schedules (site_id, pull_number, publish_at, user_id) VALUES (?, ?, ?, ?)
		ON CONFLICT (site_id, pull_number) DO UPDATE SET publish_at = excluded.publish_at, user_id = excluded.user_id`,
		sc.SiteID, sc.PullNumber, sc.PublishAt.Unix(), sc.UserID)
	return err
}

func (s *Store) DeleteSchedule(siteID int64, pullNumber int) error {
	_, err := s.db.Exec(`DELETE FROM schedules WHERE site_id = ? AND pull_number = ?`, siteID, pullNumber)
	return err
}

// Schedules returns the planned publications of a site, by pull request number.
func (s *Store) Schedules(siteID int64) (map[int]time.Time, error) {
	list, err := s.schedules(`site_id = ?`, siteID)
	out := map[int]time.Time{}
	for _, sc := range list {
		out[sc.PullNumber] = sc.PublishAt
	}
	return out, err
}

// DueSchedules returns the publications planned at or before now, on every site.
func (s *Store) DueSchedules(now time.Time) ([]Schedule, error) {
	return s.schedules(`publish_at <= ?`, now.Unix())
}

func (s *Store) schedules(where string, arg any) ([]Schedule, error) {
	rows, err := s.db.Query(`SELECT site_id, pull_number, publish_at, user_id FROM schedules WHERE `+where+` ORDER BY publish_at`, arg)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var list []Schedule
	for rows.Next() {
		var sc Schedule
		var at int64
		if err := rows.Scan(&sc.SiteID, &sc.PullNumber, &at, &sc.UserID); err != nil {
			return nil, err
		}
		sc.PublishAt = time.Unix(at, 0)
		list = append(list, sc)
	}
	return list, rows.Err()
}

// --- AI settings

// AISettings configure the AI assistant for the whole instance. Sites opt in on top of it.
type AISettings struct {
	Enabled bool `json:"enabled"`
	// Provider is an id of ai.Providers, "anthropic" when empty (settings saved before it existed).
	Provider string `json:"provider"`
	Model    string `json:"model"`
	// BaseURL overrides the provider API URL; required for "custom".
	BaseURL string `json:"base_url"`
	// APIKey is write-only, like site tokens.
	APIKey string `json:"api_key,omitempty"`
	HasKey bool   `json:"has_key"`
}

// AI returns the AI settings, with the decrypted API key.
func (s *Store) AI() (AISettings, error) {
	var ai AISettings
	var enc []byte
	err := s.db.QueryRow(`SELECT value FROM settings WHERE key = 'ai'`).Scan(&enc)
	if errors.Is(err, sql.ErrNoRows) {
		return ai, nil
	}
	if err != nil {
		return ai, err
	}
	plain, err := s.decrypt(enc)
	if err != nil {
		return ai, err
	}
	if err := json.Unmarshal([]byte(plain), &ai); err != nil {
		return ai, err
	}
	ai.HasKey = ai.APIKey != ""
	if ai.Provider == "" {
		ai.Provider = "anthropic"
	}
	return ai, nil
}

// SaveAI stores the AI settings, API key included.
func (s *Store) SaveAI(ai AISettings) error {
	plain, err := json.Marshal(ai)
	if err != nil {
		return err
	}
	enc, err := s.encrypt(string(plain))
	if err != nil {
		return err
	}
	_, err = s.db.Exec(`INSERT INTO settings (key, value) VALUES ('ai', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`, enc)
	return err
}
