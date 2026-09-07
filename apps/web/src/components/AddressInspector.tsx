import type { FormEvent } from "react";
import { Icon } from "./Icons.js";

export function AddressInspector({
  address,
  loading,
  onAddressChange,
  onInspect,
}: {
  address: string;
  loading: boolean;
  onAddressChange: (address: string) => void;
  onInspect: () => void;
}) {
  function submit(event: FormEvent) {
    event.preventDefault();
    onInspect();
  }
  return (
    <form className="address-inspector" onSubmit={submit} aria-label="Address lookup">
      <label htmlFor="address">Stacks address</label>
      <div>
        <Icon name="search" />
        <input
          id="address"
          value={address}
          onChange={(event) => onAddressChange(event.target.value.trim())}
          spellCheck={false}
          autoComplete="off"
        />
        <button className="button primary" disabled={loading}>
          {loading ? "Inspecting…" : "Inspect address"}
        </button>
      </div>
    </form>
  );
}
