import { useMemo } from 'react'
import {
  AppWindow,
  CalendarDots,
  Scan,
  type Icon,
} from '@phosphor-icons/react'

// A few example work tasks shown under the Home composer, so a new user immediately sees the kind
// of thing they can ask for. Picking one drops a starter prompt into the composer (it does not
// auto-send) so the user can tweak it before running.
type TaskSuggestion = {
  id: string
  label: string
  description: string
  prompt: string
  icon: Icon
}

// Everyday household tasks rather than office ones: this deployment serves a family. Each leans on
// a connection the deployment has (calendar, the home printer), and the prompt asks for whatever is
// not connected yet.
const SUGGESTIONS: TaskSuggestion[] = [
  {
    id: 'week-ahead',
    label: 'See my week ahead',
    description: 'Your calendar at a glance: clashes and things to prepare',
    icon: CalendarDots,
    prompt:
      'Look at my calendar for the coming seven days and give me an overview per day: what is on, anything that clashes or sits too close together, and what I need to prepare or bring. Ask me which calendar to use if it is not connected yet, and offer to send me the overview on Telegram.',
  },
  {
    id: 'scan-letter',
    label: 'Scan and explain a letter',
    description: 'Scan it on the printer, get it in plain words, and file it',
    icon: Scan,
    prompt:
      'I have a letter to deal with. Scan it on the home printer (tell me when to put it on the glass or in the feeder), read it, and tell me in plain words who it is from, what it says, and what I need to do and by when. Then offer to save the scan as a PDF and to put any deadline in my calendar.',
  },
  {
    id: 'app',
    label: 'Build a quick tool',
    description: 'A small interactive app, calculator, or dashboard',
    icon: AppWindow,
    prompt:
      'Build a small interactive tool I can use right here — a calculator, dashboard, or explorer. Ask me what it should do, then create it.',
  },
]

// One row, shared by every suggestion so the list reads as one kind of offer.
function SuggestionRow({
  icon,
  label,
  description,
  onClick,
}: {
  icon: React.ReactNode
  label: string
  description: string
  onClick: () => void
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        className="press group flex w-full cursor-pointer items-center gap-3 rounded-xl px-2 py-2 text-left transition-colors hover:bg-kumo-tint"
      >
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-kumo-fill text-kumo-subtle transition-colors group-hover:text-kumo-default">
          {icon}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] leading-[18px] font-medium tracking-[-0.25px] text-kumo-default">
            {label}
          </span>
          <span className="block truncate text-[12px] leading-4 tracking-[-0.2px] text-kumo-subtle">
            {description}
          </span>
        </span>
      </button>
    </li>
  )
}

// How many of the suggestions above to show at once. Four rows is inspiration, seven is a menu to
// read. When the list is longer than this, which ones appear is chosen per visit, so the ones below
// the fold still get seen; with exactly this many, only their order varies.
const VISIBLE_SUGGESTIONS = 3

function pickSuggestions(): TaskSuggestion[] {
  if (SUGGESTIONS.length <= VISIBLE_SUGGESTIONS) return SUGGESTIONS
  let shuffled = [...SUGGESTIONS]
  for (let i = shuffled.length - 1; i > 0; i--) {
    let j = Math.floor(Math.random() * (i + 1))
    ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
  }
  return shuffled.slice(0, VISIBLE_SUGGESTIONS)
}

export default function HomeTaskSuggestions({
  onPick,
}: {
  onPick: (prompt: string) => void
}) {
  // Chosen once per mount: re-rolling on every render would shuffle the list under the pointer.
  const visible = useMemo(pickSuggestions, [])

  return (
    <section aria-label="Example tasks" className="flex flex-col gap-1">
      <h3 className="px-1 pb-1 text-[12px] font-medium uppercase tracking-[0.06em] text-kumo-inactive">
        Get started
      </h3>
      <ul className="flex flex-col gap-0.5">
        {visible.map((suggestion) => (
          <SuggestionRow
            key={suggestion.id}
            icon={<suggestion.icon size={16} />}
            label={suggestion.label}
            description={suggestion.description}
            onClick={() => onPick(suggestion.prompt)}
          />
        ))}
      </ul>
    </section>
  )
}
