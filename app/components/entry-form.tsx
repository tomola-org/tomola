import EntryFormControls from "~/components/entry-form-controls";
import { EntryFormFrame, type EntryFormProps } from "~/components/entry-form-frame";

export { SendButton } from "~/components/entry-form-frame";

export function EntryForm(props: EntryFormProps) {
  return <EntryFormFrame {...props} controls={EntryFormControls} />;
}
