import { useMemo, useRef, useState } from 'react';
import { saveStrategy } from '@/api/strategy';
import type { Strategy, StrategyConfig } from '@/types/strategy';
import { exitRules } from '@/lib/strategy-exits';
import { sizingOf } from '@/lib/strategy-preview';
import { problemFor, strategyProblems, type FormField, type FormTab } from '@/lib/strategy-rules';

/**
 * A strategy being edited: the config, the name, what is wrong with them and
 * on which tab, and saving -- the part both strategy forms share, so the
 * clock form and the signal form check and save the same way.
 */
export function useStrategyDraft({ editing, initial, firstTab, balanceUsd, spot, onSaved, onClose, groupId = null }: {
  editing: Strategy | null;
  /** The group a new strategy is made in (a saved one keeps its own: moving it is its own act); null: none. */
  groupId?: string | null;
  /** The config a new strategy starts from. */
  initial: StrategyConfig;
  firstTab: FormTab;
  balanceUsd?: number | null;
  spot?: number | null;
  onSaved: () => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(editing?.name ?? '');
  const [c, setC] = useState<StrategyConfig>(editing?.config ?? initial);
  const [tab, setTab] = useState<FormTab>(firstTab);
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string[]>([]);
  // An empty name on a form just opened is not a mistake yet. It is said once
  // the name has been touched, or Save has been pressed.
  const [nameTouched, setNameTouched] = useState(false);
  const nameInput = useRef<HTMLInputElement>(null);

  const set = <K extends keyof StrategyConfig>(k: K, v: StrategyConfig[K]) => setC((p) => ({ ...p, [k]: v }));
  const problems = useMemo(() => strategyProblems(c, name), [c, name]);
  const exits = useMemo(() => exitRules(c), [c]);
  /*
   * The entry the exits are shown against, before there is one. Your own price
   * when the entry is set; otherwise the premium rule's number -- where the
   * offer or the bid will be, near enough -- and nothing for a rule that picks
   * the strike by position, whose price is not known until it runs.
   */
  const reference = useMemo((): { price: number | null; label: string } => {
    if (c.entryPrice === 'set' && (c.entryLimit ?? 0) > 0) return { price: c.entryLimit!, label: 'your price' };
    if (c.strikeRule === 'premium' && c.premium.usd > 0) return { price: c.premium.usd, label: c.entryPrice === 'now' ? 'bid ≈' : 'offer ≈' };
    return { price: null, label: '' };
  }, [c.entryPrice, c.entryLimit, c.strikeRule, c.premium.usd]);
  /*
   * The name box sits above the tabs, so its problem belongs to no tab: a new
   * strategy must not open with a red dot on a tab where nothing is wrong.
   */
  const nameProblem = problemFor(problems, 'name');
  const tabProblems = problems.filter((p) => p.field !== 'name');
  const tabHasProblem = (t: FormTab) => tabProblems.some((p) => p.tab === t);
  const shownCount = tabProblems.length + (nameTouched && nameProblem ? 1 : 0);
  const sizing = sizingOf(c, balanceUsd ?? null, spot ?? null);
  // "No days" is a problem, said under its own field.
  const warnings = sizing.warnings.filter((w) => !/No days/.test(w));
  const err = (f: FormField) => problemFor(problems, f);

  const save = async () => {
    if (problems.length) {
      setNameTouched(true);
      if (tabProblems.length) setTab(tabProblems[0]!.tab);
      else nameInput.current?.focus();
      return;
    }
    setBusy(true);
    setRefused([]);
    try {
      await saveStrategy({ id: editing?.id, name: name.trim(), config: c, ...(editing || !groupId ? {} : { groupId }) });
      onSaved();
      onClose();
    } catch (e) {
      setRefused((e as Error).message.split(/(?<=\.)\s+/).filter(Boolean));
    } finally {
      setBusy(false);
    }
  };

  return {
    name, setName, c, setC, set, tab, setTab, busy, refused, nameTouched, setNameTouched, nameInput,
    problems, err, exits, reference, nameProblem, tabProblems, tabHasProblem, shownCount, sizing, warnings, save,
  };
}
