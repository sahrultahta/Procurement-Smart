'use client';

import { startTransition, useEffect, useRef, type ComponentProps } from 'react';
import type { ActionState } from '@/lib/action-state';

type Props = Omit<ComponentProps<'form'>, 'action' | 'onSubmit'> & {
  /** The dispatch function from `useActionState`. */
  action: (formData: FormData) => void;
  /** With `resetOnSuccess`, the state the action returned: the fields clear when it is `ok`. */
  state?: ActionState;
  /** For forms that stay on the page to create another record (e.g. a department). */
  resetOnSuccess?: boolean;
};

/**
 * A form for a Server Action. React 19 resets uncontrolled fields after every form action it
 * runs itself, also when the server refused the input, so one mistake used to wipe what was
 * typed (and could flip a "Reject" choice back to the default "Approve"). This form runs the
 * action itself inside a transition: React then keeps `pending` but does not reset the form.
 * `action` stays on the element, so the form still works before the page has hydrated.
 */
export function ActionForm({ action, state, resetOnSuccess = false, ...props }: Props) {
  const ref = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (resetOnSuccess && state?.status === 'ok') ref.current?.reset();
  }, [resetOnSuccess, state]);

  return (
    <form
      {...props}
      ref={ref}
      action={action}
      onSubmit={(event) => {
        event.preventDefault();
        // The clicked button's name and value, as a native submission would send them.
        const formData = new FormData(event.currentTarget, (event.nativeEvent as SubmitEvent).submitter);
        startTransition(() => action(formData));
      }}
    />
  );
}
