/**
 * React 18.3's react-dom has no useFormState/useFormStatus (Next bundles its
 * own React), so markup tests swap them for inert versions: the form state is
 * the initial state and nothing is pending. Use as
 *
 *   vi.mock("react-dom", async (orig) => formHooksMock(await orig()));
 *
 * Every action handed to useFormState is recorded in `formActionsUsed`, so a
 * test can say which server action a rendered form would post to. To render a
 * form as if its action had returned something, put that state in
 * `formStateFor` keyed by the action (cleared by the test).
 */
export const formActionsUsed: unknown[] = [];
export const formStateFor = new Map<unknown, unknown>();

export function formHooksMock<T extends object>(actual: T): T {
  return {
    ...actual,
    useFormState: (action: unknown, initial: unknown) => {
      formActionsUsed.push(action);
      return [formStateFor.has(action) ? formStateFor.get(action) : initial, () => {}];
    },
    useFormStatus: () => ({ pending: false }),
  };
}
