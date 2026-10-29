import type { ComponentProps, ComponentPropsWithoutRef, ReactNode } from 'react'
import { ScrubbableLabel } from './ScrubbableLabel'

interface ScrubbableNumberInputProps extends Omit<
  ComponentPropsWithoutRef<'input'>,
  'children' | 'type' | 'value' | 'onChange' | 'onBlur'
> {
  label: ReactNode
  value: number
  onValueChange: (value: number, commit: boolean) => void
  parseInput?: (raw: string) => number
  // Drag limits can differ from the native input's min/max attributes.
  scrubProps?: Pick<ComponentProps<typeof ScrubbableLabel>, 'min' | 'max' | 'step' | 'sensitivity'>
}

export function ScrubbableNumberInput({
  label,
  value,
  onValueChange,
  parseInput = (raw) => Number(raw) || 0,
  scrubProps,
  ...inputProps
}: ScrubbableNumberInputProps) {
  return (
    <>
      <ScrubbableLabel
        {...scrubProps}
        label={label}
        onChange={(next) => onValueChange(next, false)}
        onChangeEnd={(next) => onValueChange(next, true)}
        value={value}
      />
      <input
        className="inspector-field__input"
        {...inputProps}
        onBlur={(event) => onValueChange(parseInput(event.target.value), true)}
        onChange={(event) => onValueChange(parseInput(event.target.value), false)}
        type="number"
        value={value}
      />
    </>
  )
}
