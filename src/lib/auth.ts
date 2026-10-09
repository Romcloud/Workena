import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import { PrismaAdapter } from "@auth/prisma-adapter";
import { db } from "@/lib/db";

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: PrismaAdapter(db),
  providers: [
    Google({
      clientId: process.env.AUTH_GOOGLE_ID,
      clientSecret: process.env.AUTH_GOOGLE_SECRET,
      authorization: { params: { prompt: "select_account" } },
    }),
  ],
  session: { strategy: "database" },
  pages: { signIn: "/" },
  callbacks: {
    async signIn({ account, profile }) {
      if (account?.provider !== "google") return false;
      const googleProfile = profile as { email_verified?: boolean; hd?: string } | undefined;
      if (!googleProfile?.email_verified) return false;
      const requiredDomain = process.env.GOOGLE_WORKSPACE_DOMAIN?.trim().toLowerCase();
      if (requiredDomain && googleProfile.hd?.toLowerCase() !== requiredDomain) return false;
      return true;
    },
    async session({ session, user }) {
      if (session.user) session.user.id = user.id;
      return session;
    },
  },
});
