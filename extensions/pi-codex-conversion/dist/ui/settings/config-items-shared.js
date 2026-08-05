import { Container, Input, Spacer, Text, } from "@earendil-works/pi-tui";
export class TextSettingSubmenu extends Container {
    input;
    constructor(title, description, currentValue, onSubmit, onCancel, theme) {
        super();
        this.input = new Input();
        this.input.setValue(currentValue);
        this.input.onSubmit = () => onSubmit(this.input.getValue());
        this.input.onEscape = onCancel;
        this.addChild(new Text(theme.bold(theme.fg("accent", title)), 0, 0));
        this.addChild(new Spacer(1));
        this.addChild(new Text(theme.fg("dim", description), 0, 0));
        this.addChild(new Spacer(1));
        this.addChild(this.input);
        this.addChild(new Spacer(1));
        this.addChild(new Text(theme.fg("dim", "  Enter to save · Esc to cancel"), 0, 0));
    }
    get focused() {
        return this.input.focused;
    }
    set focused(value) {
        this.input.focused = value;
    }
    handleInput(data) {
        this.input.handleInput(data);
    }
}
export function setting(item, update) {
    return { item, ...(update ? { update } : {}) };
}
export function toggle(id, label, current, update) {
    return setting({ id, label, currentValue: current ? "on" : "off", values: ["off", "on"] }, (value, config) => update(value === "on", config));
}
