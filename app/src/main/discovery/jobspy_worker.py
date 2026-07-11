"""One-request JSON bridge around the MIT-licensed python-jobspy package."""

import json
import math
import sys
from datetime import date, datetime


def clean(value):
    if value is None:
        return None
    if isinstance(value, float) and math.isnan(value):
        return None
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, dict):
        return {str(k): clean(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [clean(v) for v in value]
    try:
        if hasattr(value, "item"):
            return clean(value.item())
    except Exception:
        pass
    return value


def main():
    request = json.loads(sys.stdin.readline() or "{}")
    from jobspy import scrape_jobs

    source = str(request.get("source") or "indeed").lower()
    wanted = max(1, min(100, int(request.get("limit") or 25)))
    country = str(request.get("country") or "Canada")
    # `location` is ALWAYS a geography. LinkedIn has no country param, so the geography
    # must carry it — when the planner sends an empty location, fall back to the country
    # so a search is never borderless. Work-mode ("remote") is a SEPARATE boolean below,
    # never folded into the location string.
    location = str(request.get("location") or "").strip() or country
    hours_old = max(1, min(720, int(request.get("hours_old") or 72)))
    easy_apply = bool(request.get("easy_apply"))
    kwargs = {
        "site_name": [source],
        "search_term": str(request.get("keyword") or ""),
        "location": location,
        "results_wanted": wanted,
        "verbose": 0,
    }
    # Optional search radius in miles (JobSpy defaults to 50; a wider radius pulls more of the metro).
    if request.get("distance"):
        kwargs["distance"] = max(1, min(100, int(request["distance"])))
    if source in ("indeed", "glassdoor"):
        kwargs["country_indeed"] = country
    # INDEED CONSTRAINT: JobSpy allows only ONE of {hours_old, is_remote/job_type, easy_apply} per
    # Indeed search. easy_apply=True filters to jobs HOSTED ON the board (Indeed-Apply / "Easily
    # apply") — the ones we can actually auto-submit — dropping the ~30% external company-site bounces
    # that were the single biggest waste. When asked for it (Indeed/LinkedIn) use it and skip the
    # mutually-exclusive freshness/remote filters; otherwise use the freshness window (+ optional
    # remote). Google is a separate natural-language path and always uses the freshness hint.
    if easy_apply and source in ("indeed", "linkedin"):
        kwargs["easy_apply"] = True
    elif source == "google":
        # JobSpy IGNORES the plain `search_term` for Google; it needs ONE natural-language phrase.
        term = str(request.get("keyword") or "").strip()
        since = "since yesterday" if hours_old <= 24 else ("in the last week" if hours_old <= 168 else "in the last month")
        parts = [p for p in [term, "jobs", ("near " + location) if location else "", since] if p]
        kwargs["google_search_term"] = " ".join(parts)
        kwargs["hours_old"] = hours_old
    else:
        kwargs["hours_old"] = hours_old
        if request.get("remote"):
            kwargs["is_remote"] = True
    if request.get("proxies"):
        kwargs["proxies"] = request["proxies"]

    frame = scrape_jobs(**kwargs)
    records = frame.to_dict(orient="records") if frame is not None else []
    print(json.dumps({"ok": True, "source": source, "jobs": clean(records)}, ensure_ascii=True))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc), "type": exc.__class__.__name__}, ensure_ascii=True))
        sys.exit(1)
