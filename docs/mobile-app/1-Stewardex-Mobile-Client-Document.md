# Stewardex Mobile Application — Client Overview

**Document type:** Client-facing scope & feature document
**Product:** Stewardex Mobile (companion app to the Stewardex web platform)
**Release:** Phase 1
**Date:** 15 June 2026
**Status:** For client review & sign-off

---

## 1. Introduction

Stewardex is a charity governance and compliance platform that helps boards, trustees, and staff run their organisation correctly — managing meetings, policies, risks, conflicts of interest, complaints, expenses, approvals, and team communication in one place.

Today Stewardex is delivered as a web application. **Stewardex Mobile** brings the day-to-day, on-the-go essentials of that platform to a native iOS and Android app so trustees and staff can stay on top of their responsibilities without sitting at a desk.

This document describes **what the mobile app will do in Phase 1**, who it is for, and what is in and out of scope.

---

## 2. Goals of the Mobile App

| Goal | What it means for users |
|------|------------------------|
| **Stay informed anywhere** | Push notifications for approvals waiting on you, meeting reminders, chat mentions, and policy actions. |
| **Act quickly** | Approve or reject requests, acknowledge policies, RSVP to meetings, and complete tasks from your phone. |
| **Stay connected** | Real-time team chat with channels, threads, and reactions. |
| **Stay compliant** | View the live Risk, Conflict of Interest, and Complaint registers, and submit expenses on the move. |
| **Self-serve** | Manage your profile, security (MFA, password), billing, and get help — all in-app. |

The mobile app is a **companion** to the web platform. Heavy administrative tasks (configuring workflows, full register management, org setup) remain on the web. The mobile app focuses on the actions people need to take frequently and quickly.

---

## 3. Who It's For

- **Trustees / Board members** — review and approve, attend meetings, acknowledge policies, declare conflicts of interest.
- **Staff** — submit expenses, complete tasks, chat with the team, raise and track support tickets.
- **Finance & compliance leads** — monitor registers, approve expenses, track billing and usage.

Every user signs in to **their own organisation** (Stewardex is multi-organisation), and only sees data and actions their role permits — exactly as on the web.

---

## 4. Phase 1 Feature Set

The mobile app delivers the following 14 capabilities in Phase 1.

### 4.1 Calendar
A consolidated view of the organisation's important dates — trustee meetings, policy review dates, training renewals, registration/licence expiries, and personal tasks. Users can view by month/week/day or as a list, see what's "expiring soon," and create or complete events.

### 4.2 Meetings
See upcoming and past meetings (board, general, resolution), grouped by Today / This Week / Later / Past. View meeting details, location, time, and attendees; RSVP; mark meetings as important; and read meeting minutes/notes.

### 4.3 My Tasks
A single inbox of everything that needs the user's attention — pending approvals, today's meetings, and calendar tasks — with the ability to mark items as done and flag priorities.

### 4.4 Chat
Real-time team messaging with channels (general, group, and direct), threaded replies, emoji reactions, message search, starred messages, and online-presence indicators. Includes typing indicators and unread badges.

### 4.5 Approval Workflow
Review and act on requests routed to you — expenses, policies, risks, conflicts of interest, grants, purchases, and more. See the full approval chain, the current step, and approve or reject with a comment.

### 4.6 Policies (View & Acknowledge)
Browse the organisation's policies with their status, version, and review dates; open and read the policy document; and record your acknowledgement / sign-off.

### 4.7 Risk Register (View)
View the live risk register — risk titles, owners, categories, likelihood/consequence ratings, and inherent vs. residual scores — with search and filtering. (View-only on mobile in Phase 1.)

### 4.8 Conflict of Interest (COI) Register (View)
View declared conflicts of interest and their status. Users can also submit their own declaration. (Register is view-only; declaration is supported.)

### 4.9 Complaint Register (View)
View the complaint register and complaint details, including status (new, assigned, in progress, resolved) and assigned handler. (View-only on mobile in Phase 1.)

### 4.10 Expenses
Submit an expense on the go — amount, category, supplier, project allocation, and an invoice photo/upload — which then enters the approval workflow. View the status of submitted expenses.

### 4.11 Billing
View the organisation's current subscription plan, usage against limits, active discounts, and recent billing activity. Initiate plan upgrades and manage payment via the secure Stripe portal.

### 4.12 Help Center
Raise support tickets, track their status, and reply within a conversation thread — without leaving the app.

### 4.13 Settings (Profile, MFA, Password)
Manage your profile (name, picture), enable/disable multi-factor authentication via an authenticator app, and change your password.

### 4.14 Push Notifications
Native push notifications for the events that matter — approvals awaiting you, meeting reminders, chat mentions, policy actions, and workflow outcomes — with the ability to tap straight through to the relevant item.

---

## 5. Platforms & Access

- **Platforms:** Native apps for **iOS** (iPhone) and **Android**.
- **Sign-in:** Email + password, followed by a one-time code (OTP). Optional authenticator-app MFA for added security.
- **Organisation-aware:** Users belonging to a single organisation are signed straight in; the app respects each user's role and permissions.
- **Connectivity:** The app requires an internet connection (live data). Limited offline viewing of already-loaded content may be considered in a later phase.

---

## 6. What's In and Out of Scope (Phase 1)

**In scope**
- The 14 features above.
- View + act for registers where listed (acknowledge policies, approve/reject, submit expenses, RSVP, declare COI).
- Real-time chat and notifications.
- Self-service profile, security, billing, and support.

**Out of scope for Phase 1** (remains on the web platform)
- Configuring approval workflows / permission matrices.
- Creating and editing risks, complaints, and full register administration (mobile is view-only for these).
- Organisation onboarding and setup wizards.
- Advanced reporting, fiscal reports, grants/donor management, HR/training modules, and the super-admin portal.

---

## 7. Security & Compliance

- Each user only ever sees their own organisation's data (strict multi-tenant separation).
- All actions are permission-checked, exactly as on the web — auditor accounts remain read-only.
- Multi-factor authentication (authenticator app) is supported.
- Payments are handled by **Stripe**; the app never stores card details.
- All traffic is encrypted in transit.

---

## 8. Assumptions & Dependencies

- The mobile app connects to the **existing Stewardex backend**; no separate data store is introduced.
- Most required data and actions are already supported by the backend. A small number of mobile-specific additions are needed (primarily **native push-notification delivery** for iOS/Android), detailed in the developer documentation.
- Branding, colours, and typography will follow the existing Stewardex identity.

---

## 9. Next Steps

1. Client review and sign-off on this Phase 1 scope.
2. UI/UX design of the 14 screens for mobile.
3. Frontend and backend development (see companion developer documents).
4. Testing on iOS and Android, followed by store submission.

---

*Companion documents: "Stewardex Mobile — Frontend Developer Guide" and "Stewardex Mobile — Backend Developer Guide."*
