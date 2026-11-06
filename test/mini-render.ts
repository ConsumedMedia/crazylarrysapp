/**
 * A very small component runner, for testing form behaviour without a browser
 * or a DOM library. It calls the real components, keeps their useState / useRef
 * values between renders, runs their effects, and lets a test call the real
 * event handlers on the elements they return.
 *
 * Use with:
 *   vi.mock("react", async (orig) => ({ ...(await orig<object>()), ...hooks }));
 * (via a dynamic import of this file inside the factory). Client components
 * only; suspense, context and portals aren't supported, because the forms it
 * tests don't use them.
 */
import type { ReactElement, ReactNode } from "react";

type Slot = { value: unknown } | { deps: unknown[] | undefined; cleanup?: void | (() => void) };

let slots: Slot[] = [];
let cursor = 0;
let pending: Array<() => void> = [];

const next = <T extends Slot>(init: () => T): T => {
  if (cursor >= slots.length) slots.push(init());
  return slots[cursor++] as T;
};

export const hooks = {
  useState<T>(initial: T | (() => T)) {
    const slot = next(() => ({ value: typeof initial === "function" ? (initial as () => T)() : initial }));
    const set = (v: T | ((old: T) => T)) => {
      slot.value = typeof v === "function" ? (v as (old: T) => T)(slot.value as T) : v;
    };
    return [slot.value as T, set] as const;
  },
  useRef<T>(initial: T) {
    return next(() => ({ value: { current: initial } })).value as { current: T };
  },
  useMemo<T>(fn: () => T) {
    return fn();
  },
  useEffect(fn: () => void | (() => void), deps?: unknown[]) {
    const slot = next(() => ({ deps: undefined as unknown[] | undefined, cleanup: undefined as void | (() => void), ran: false })) as {
      deps: unknown[] | undefined;
      cleanup?: void | (() => void);
      ran: boolean;
    };
    const changed = !slot.ran || !deps || !slot.deps || deps.some((d, i) => !Object.is(d, slot.deps![i]));
    if (changed) {
      pending.push(() => {
        if (typeof slot.cleanup === "function") slot.cleanup();
        slot.cleanup = fn();
        slot.deps = deps;
        slot.ran = true;
      });
    }
  },
};

export interface Host {
  type: string;
  props: Record<string, unknown>;
  text: string;
}

const isElement = (n: unknown): n is ReactElement => typeof n === "object" && n !== null && "type" in n && "props" in n;

/** Expand components into host elements, in document order. */
function expand(node: ReactNode, out: Host[]): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map((n) => expand(n as ReactNode, out)).join("");
  if (!isElement(node)) return "";
  const { type, props } = node as ReactElement<Record<string, unknown>>;
  if (typeof type === "function") return expand((type as (p: unknown) => ReactNode)(props), out);
  if (typeof type !== "string") return expand(props.children as ReactNode, out); // Fragment, next/link
  const host: Host = { type, props, text: "" };
  out.push(host);
  host.text = expand(props.children as ReactNode, out);
  return host.text;
}

export function mount(root: () => ReactElement) {
  slots = [];
  const render = () => {
    const hosts: Host[] = [];
    // Effects can set state, so settle until a render schedules none.
    for (let i = 0; i < 10; i++) {
      hosts.length = 0;
      cursor = 0;
      pending = [];
      expand(root(), hosts);
      const run = pending;
      if (run.length === 0) break;
      run.forEach((f) => f());
    }
    return hosts;
  };

  const find = (test: (h: Host) => boolean, what: string) => {
    const h = render().find(test);
    if (!h) throw new Error(`mini-render: nothing matches ${what}`);
    return h;
  };

  return {
    hosts: render,
    /** All visible text. */
    text: () => render().filter((h) => !["input", "select", "option"].includes(h.type)).map((h) => h.text).join(" | "),
    input: (name: string) => find((h) => h.type === "input" && h.props.name === name, `input ${name}`),
    has: (name: string) => render().some((h) => h.type === "input" && h.props.name === name),
    type(name: string, value: string) {
      const h = find((x) => x.type === "input" && x.props.name === name, `input ${name}`);
      (h.props.onChange as (e: unknown) => void)({ currentTarget: { value, checked: value === "on" } });
      render();
    },
    tick(name: string, checked: boolean) {
      const h = find((x) => x.type === "input" && x.props.name === name, `input ${name}`);
      (h.props.onChange as (e: unknown) => void)({ currentTarget: { checked } });
      render();
    },
    button: (label: string) => find((h) => h.type === "button" && h.text.includes(label), `button "${label}"`),
    hasButton: (label: string) => render().some((h) => h.type === "button" && h.text.includes(label)),
    click(label: string) {
      const h = find((x) => x.type === "button" && x.text.includes(label), `button "${label}"`);
      (h.props.onClick as () => void)();
      render();
    },
    /** Pick the nth result row (the real onMouseDown). */
    pickResult(n = 0) {
      const rows = render().filter((h) => h.props.role === "option");
      if (!rows[n]) throw new Error("mini-render: no search result row");
      (rows[n].props.onMouseDown as (e: unknown) => void)({ preventDefault() {} });
      render();
    },
    /** What the browser would submit: every named input, as FormData. */
    formData() {
      const fd = new FormData();
      for (const h of render()) {
        const name = h.props.name as string | undefined;
        if (!name || (h.type !== "input" && h.type !== "select")) continue;
        if (h.props.type === "checkbox") {
          if (h.props.checked) fd.set(name, "on");
        } else fd.set(name, String(h.props.value ?? h.props.defaultValue ?? ""));
      }
      return fd;
    },
  };
}
