import { useState } from "react";
import { Button } from "./ui/button";
import { Calendar } from "./ui/calendar";

interface CalendarEvent {
  readonly id: string;
  readonly title: string;
  readonly startsAt: Date;
  readonly allDay: boolean;
}

interface CalendarEventSource {
  eventsForDay: (day: Date) => readonly CalendarEvent[];
}

const emptyCalendarSource: CalendarEventSource = { eventsForDay: () => [] };

export function CalendarTool({ source = emptyCalendarSource }: { source?: CalendarEventSource }) {
  const [day, setDay] = useState(() => new Date());
  const [month, setMonth] = useState(day);
  const events = source.eventsForDay(day);
  const label = day.toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto">
      <div className="flex flex-col items-center gap-2 border-b p-3">
        <Calendar
          mode="single"
          required
          selected={day}
          onSelect={setDay}
          month={month}
          onMonthChange={setMonth}
        />
        <Button
          size="xs"
          variant="ghost"
          onClick={() => {
            const today = new Date();
            setDay(today);
            setMonth(today);
          }}
        >
          Today
        </Button>
      </div>
      <section className="p-4" aria-label="Day agenda">
        <h3 className="text-sm font-medium" aria-live="polite">
          {label}
        </h3>
        {events.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">No events</p>
        ) : (
          <ul className="mt-3 space-y-3">
            {events.map((event) => (
              <li key={event.id} className="text-sm">
                <p>{event.title}</p>
                <p className="text-xs text-muted-foreground">
                  {event.allDay
                    ? "All day"
                    : event.startsAt.toLocaleTimeString(undefined, {
                        hour: "numeric",
                        minute: "2-digit",
                      })}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
