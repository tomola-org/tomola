import { Field, FieldLabel } from "~/components/ui/field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select";
import { m } from "~/paraglide/messages.js";

export function InvitationVillageSelect({ villages, value, onValueChange }: {
  villages: { id: string; name: string }[];
  value?: string;
  onValueChange?: (value: string) => void;
}) {
  if (!villages.length) return null;
  return <Field className="min-w-0 w-auto">
    <FieldLabel htmlFor="invitation-village">{m.invites_village()}</FieldLabel>
    <Select name="villageId" defaultValue="" value={value} onValueChange={next => onValueChange?.(next ?? "")}
      items={[{ value: "", label: m.invites_village_none() }, ...villages.map(village => ({ value: village.id, label: village.name }))]}>
      <SelectTrigger id="invitation-village" className="w-full"><SelectValue /></SelectTrigger>
      <SelectContent>
        <SelectItem value="">{m.invites_village_none()}</SelectItem>
        {villages.map(village => <SelectItem key={village.id} value={village.id}>{village.name}</SelectItem>)}
      </SelectContent>
    </Select>
  </Field>;
}
