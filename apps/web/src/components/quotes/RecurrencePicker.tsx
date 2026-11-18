"use client";

// 頻度の選び方：毎週◯曜・毎月第◯◯曜・毎月◯日・◯か月に1回。選んだものを RRULE の文字列にして渡し、日本語の訳も見せる（R-004-27・28）
import { buildRrule, parseRecurrence, rruleToJa, WEEKDAYS, weekdayLabel, type Recurrence, type Weekday } from "@/lib/quotes/rrule";

type Choice = "none" | Recurrence["type"] | "custom";

const DEFAULTS: Record<Recurrence["type"], Recurrence> = {
  weekly: { type: "weekly", weekdays: ["MO"], interval: 1 },
  monthly_nth: { type: "monthly_nth", nth: 1, weekday: "MO" },
  monthly_day: { type: "monthly_day", day: 1 },
  every_months: { type: "every_months", months: 1 },
};

export function RecurrencePicker({ value, onChange }: { value: string; onChange: (rule: string) => void }) {
  const rec = value ? parseRecurrence(value) : null;
  const choice: Choice = !value ? "none" : rec ? rec.type : "custom";

  function pick(c: string) {
    if (c === "none") return onChange("");
    if (c === "custom") return;
    onChange(buildRrule(DEFAULTS[c as Recurrence["type"]]));
  }
  const num = (v: string, min: number, max: number, fallback: number) => {
    const n = Number(v);
    return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
  };

  return (
    <div className="m-field">
      <label>頻度</label>
      <select aria-label="頻度の種類" value={choice} onChange={(e) => pick(e.target.value)}>
        <option value="none">なし（繰り返さない）</option>
        <option value="weekly">毎週 ◯曜</option>
        <option value="monthly_nth">毎月 第◯ ◯曜</option>
        <option value="monthly_day">毎月 ◯日</option>
        <option value="every_months">◯か月に1回</option>
        {choice === "custom" ? <option value="custom">そのほか（{value}）</option> : null}
      </select>

      {rec?.type === "weekly" ? (
        <div className="m-row">
          {WEEKDAYS.map((d: Weekday) => (
            <label key={d} style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
              <input
                type="checkbox"
                checked={rec.weekdays.includes(d)}
                onChange={(e) =>
                  onChange(buildRrule({ ...rec, weekdays: e.target.checked ? [...rec.weekdays, d] : rec.weekdays.filter((x) => x !== d) }))
                }
              />
              {weekdayLabel(d)}
            </label>
          ))}
          <label style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
            <select aria-label="週の間隔" value={rec.interval} onChange={(e) => onChange(buildRrule({ ...rec, interval: Number(e.target.value) }))}>
              <option value={1}>毎週</option>
              <option value={2}>2週間に1回</option>
              <option value={3}>3週間に1回</option>
              <option value={4}>4週間に1回</option>
            </select>
          </label>
        </div>
      ) : null}

      {rec?.type === "monthly_nth" ? (
        <div className="m-row">
          <select aria-label="第何" value={rec.nth} onChange={(e) => onChange(buildRrule({ ...rec, nth: Number(e.target.value) }))}>
            {[1, 2, 3, 4].map((n) => (
              <option key={n} value={n}>
                第{n}
              </option>
            ))}
            <option value={-1}>最終</option>
          </select>
          <select aria-label="曜日" value={rec.weekday} onChange={(e) => onChange(buildRrule({ ...rec, weekday: e.target.value as Weekday }))}>
            {WEEKDAYS.map((d) => (
              <option key={d} value={d}>
                {weekdayLabel(d)}
              </option>
            ))}
          </select>
        </div>
      ) : null}

      {rec?.type === "monthly_day" ? (
        <div className="m-row">
          <select aria-label="日" value={rec.day} onChange={(e) => onChange(buildRrule({ ...rec, day: Number(e.target.value) }))}>
            {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
              <option key={d} value={d}>
                {d}日
              </option>
            ))}
            <option value={-1}>月末</option>
          </select>
        </div>
      ) : null}

      {rec?.type === "every_months" ? (
        <div className="m-row">
          <input
            aria-label="何か月に1回"
            style={{ width: 80 }}
            inputMode="numeric"
            value={rec.months}
            onChange={(e) => onChange(buildRrule({ ...rec, months: num(e.target.value, 1, 24, rec.months) }))}
          />
          か月に1回
        </div>
      ) : null}

      {value ? <span className="q-freq">→ {rruleToJa(value)}</span> : null}
    </div>
  );
}
