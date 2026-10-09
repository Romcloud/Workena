export const messages = {
  sk: {
    locale: "sk-SK",
    common: {
      signIn: "Prihlásiť sa",
      signOut: "Odhlásiť sa",
      save: "Uložiť",
      cancel: "Zrušiť",
      loading: "Načítavam…",
      error: "Niečo sa pokazilo. Skúste to znova.",
    },
    navigation: {
      dashboard: "Prehľad",
      newEntry: "Nový záznam",
      team: "Tím",
    },
  },
} as const;

export type Locale = keyof typeof messages;
export type MessageKey = keyof (typeof messages)["sk"]["common"];

export function getMessages(locale: Locale = "sk") {
  return messages[locale];
}
