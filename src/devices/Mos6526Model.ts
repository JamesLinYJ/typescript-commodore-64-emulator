export const MOS_6526_MODEL = {
  original: '6526',
  revised: '6526A',
} as const;

export type Mos6526Model = (typeof MOS_6526_MODEL)[keyof typeof MOS_6526_MODEL];

export const DEFAULT_MOS_6526_MODEL: Mos6526Model = MOS_6526_MODEL.original;
