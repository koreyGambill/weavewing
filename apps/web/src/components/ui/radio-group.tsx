import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import { RadioGroup as RadioGroupPrimitive } from "@base-ui/react/radio-group";

import { cn } from "~/lib/utils";

function RadioGroup({
  className,
  density = "default",
  ...props
}: RadioGroupPrimitive.Props & {
  /** `compact` stacks rows that carry their own padding, such as one-line option rows. */
  readonly density?: "default" | "compact";
}) {
  return (
    <RadioGroupPrimitive
      className={cn("flex flex-col", density === "compact" ? "gap-px" : "gap-3", className)}
      data-slot="radio-group"
      {...props}
    />
  );
}

const radioVariantClassNames = {
  default: "",
  // A border mixed from the text colour that stays full strength while disabled, so it shows on any theme.
  contrast: "border-foreground/55 bg-clip-padding data-disabled:opacity-100",
};

function Radio({
  className,
  variant = "default",
  ...props
}: RadioPrimitive.Root.Props & { variant?: keyof typeof radioVariantClassNames }) {
  return (
    <RadioPrimitive.Root
      // Keeps Base UI's hidden input beside the control; see `rootClassName` in checkbox.tsx.
      className={cn(
        "relative inline-flex size-4.5 shrink-0 items-center justify-center rounded-full border border-input bg-background not-dark:bg-clip-padding shadow-xs/5 outline-none transition-shadow before:pointer-events-none before:absolute before:inset-0 before:rounded-full not-data-disabled:not-data-checked:not-aria-invalid:before:shadow-[0_1px_--theme(--color-black/4%)] focus-visible:outline-2 focus-visible:outline-solid focus-visible:-outline-offset-2 focus-visible:outline-ring aria-invalid:border-destructive/36 focus-visible:aria-invalid:border-destructive/64 focus-visible:aria-invalid:outline-destructive/48 data-disabled:opacity-64 sm:size-4 dark:not-data-checked:bg-input/32 dark:focus-visible:aria-invalid:outline-destructive/24 dark:not-data-disabled:not-data-checked:not-aria-invalid:before:shadow-[0_-1px_--theme(--color-white/6%)] [[data-disabled],[data-checked],[aria-invalid]]:shadow-none [&+input]:absolute! [&+input]:top-auto! [&+input]:left-auto!",
        radioVariantClassNames[variant],
        className,
      )}
      data-slot="radio"
      {...props}
    >
      <RadioPrimitive.Indicator
        className="-inset-px absolute flex size-4.5 items-center justify-center rounded-full before:size-2 before:rounded-full before:bg-primary-foreground data-unchecked:hidden data-checked:bg-primary sm:size-4 sm:before:size-1.5 in-[[data-slot=radio]:focus-visible]:inset-shadow-[0_0_0_3px_var(--background)] in-[[data-slot=radio]:focus-visible]:outline-2 in-[[data-slot=radio]:focus-visible]:outline-solid in-[[data-slot=radio]:focus-visible]:-outline-offset-2 in-[[data-slot=radio]:focus-visible]:outline-inherit"
        data-slot="radio-indicator"
      />
    </RadioPrimitive.Root>
  );
}

export { RadioGroup, Radio, Radio as RadioGroupItem };
