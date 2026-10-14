package api

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"time"

	"github.com/ermos/sumigo/internal/store"
)

// schedulePull plans the publication of a draft pull request.
func (a *API) schedulePull(w http.ResponseWriter, r *http.Request) {
	sc, ok := a.site(w, r, store.RoleEditor)
	if !ok {
		return
	}
	var in struct {
		PublishAt time.Time `json:"publish_at"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	if !in.PublishAt.After(time.Now()) {
		httpError(w, http.StatusBadRequest, "schedule_past", "the publication date must be in the future")
		return
	}
	p, ok := a.publishablePull(w, r, sc)
	if !ok {
		return
	}
	if err := a.Store.SetSchedule(store.Schedule{SiteID: sc.site.ID, PullNumber: p.Number, PublishAt: in.PublishAt, UserID: sc.user.ID}); err != nil {
		fail(w, err)
		return
	}
	at := in.PublishAt.Truncate(time.Second)
	p.ScheduledAt = &at
	writeJSON(w, p)
}

func (a *API) unschedulePull(w http.ResponseWriter, r *http.Request) {
	sc, ok := a.site(w, r, store.RoleEditor)
	if !ok {
		return
	}
	if !sc.canPublish() {
		httpError(w, http.StatusForbidden, "publisher_only", "only publishers can publish on this site")
		return
	}
	if err := a.Store.DeleteSchedule(sc.site.ID, int(pathID(r, "number"))); err != nil {
		fail(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// RunScheduler publishes the drafts whose time has come, every interval, until ctx is done.
func (a *API) RunScheduler(ctx context.Context, every time.Duration) {
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		a.publishDue(ctx, time.Now())
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

// ponytail: a publish that fails (merge conflict, forge down) is retried on every tick and logged;
// store the last error and show it in the UI if that turns out to happen often.
func (a *API) publishDue(ctx context.Context, now time.Time) {
	due, err := a.Store.DueSchedules(now)
	if err != nil {
		log.Printf("scheduler: %v", err)
		return
	}
	for _, s := range due {
		if err := a.publishScheduled(ctx, s); err != nil {
			log.Printf("scheduler: site %d, pull request #%d: %v", s.SiteID, s.PullNumber, err)
		}
	}
}

// publishScheduled merges one draft as the user who scheduled it, if they still may publish.
func (a *API) publishScheduled(ctx context.Context, s store.Schedule) error {
	drop := func() error { return a.Store.DeleteSchedule(s.SiteID, s.PullNumber) }
	u, err := a.Store.UserByID(s.UserID)
	if err != nil {
		return err
	}
	site, err := a.Store.GetSite(s.SiteID)
	if err != nil {
		return err
	}
	if site.Role, err = a.Store.Role(u, site.ID); err != nil {
		return err
	}
	sc := &siteCtx{site: site, user: u}
	if !sc.canPublish() {
		return fmt.Errorf("%s may no longer publish, schedule dropped: %w", u.Email, drop())
	}
	token, err := a.Store.SiteToken(site.ID)
	if err != nil {
		return err
	}
	sc.gh = a.NewForge(site.Forge, site.ForgeURL, token, site.Repo)
	pulls, err := sc.gh.ListPulls(ctx, branchPrefix)
	if err != nil {
		return err
	}
	for i := range pulls {
		if pulls[i].Number == s.PullNumber {
			return a.publish(ctx, sc, &pulls[i], "scheduled")
		}
	}
	// Published or discarded in the meantime: nothing left to do.
	return drop()
}
