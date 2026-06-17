/**
 * Weekly report definitions (#5, #11).
 *
 * Config-driven weekly data-entry reports. Each type has sections of fields
 * (number | text | textarea | checkbox). A weekly instance stores values keyed
 * by field `key`. Sources: spreadsheet Sheet5 (Volunteer Engagement) and
 * Sheet17 (Weekly Statistics Reporting & Record Keeping).
 */

export const WEEKLY_REPORT_CONFIG = {
  volunteer_engagement: {
    label: 'Volunteer Engagement Weekly Report',
    description: 'Weekly volunteer metrics and engagement summary.',
    sections: [
      {
        title: 'Weekly Volunteer Engagement',
        fields: [
          { key: 'active_volunteers', label: 'Number of Active Volunteers', type: 'number' },
          { key: 'total_hours', label: 'Total Volunteer Hours', type: 'number' },
          { key: 'new_registrations', label: 'New Volunteer Registrations', type: 'number' },
          { key: 'drop_offs', label: 'Volunteer Drop-offs', type: 'number' },
          { key: 'participation_rate', label: 'Participation Rate (%)', type: 'number' },
          { key: 'activities', label: 'Activities and Events Conducted', type: 'textarea' },
          { key: 'satisfaction', label: 'Volunteer Satisfaction Feedback', type: 'textarea' },
          { key: 'training_sessions', label: 'Training Sessions Conducted', type: 'textarea' },
          { key: 'achievements', label: 'Notable Achievements / Challenges', type: 'textarea' }
        ]
      }
    ]
  },
  weekly_statistics: {
    label: 'Weekly Statistics Reporting & Record Keeping',
    description: 'Weekly statistics and record-keeping across all functions.',
    sections: [
      {
        title: 'Fundraising Activities',
        fields: [
          { key: 'new_donors', label: 'Number of new donors', type: 'number' },
          { key: 'fundraising_events', label: 'Record details of fundraising events held', type: 'checkbox' },
          { key: 'funds_logged', label: 'Log funds raised from events', type: 'checkbox' },
          { key: 'calendar_updated', label: 'Update fundraising event calendar', type: 'checkbox' },
          { key: 'activity_report', label: 'Prepare weekly fundraising activity report', type: 'checkbox' },
          { key: 'thank_you_notes', label: 'Send thank-you notes to event donors and participants', type: 'checkbox' },
          { key: 'event_feedback', label: 'Review and log event feedback', type: 'checkbox' }
        ]
      },
      {
        title: 'Program / Service Delivery',
        fields: [
          { key: 'incidents', label: 'Any incidents or issues reported', type: 'text' },
          { key: 'beneficiary_db', label: 'Update beneficiary database', type: 'checkbox' },
          { key: 'beneficiary_feedback', label: 'Collect and log beneficiary feedback', type: 'checkbox' },
          { key: 'services_recorded', label: 'Record details of services provided', type: 'checkbox' },
          { key: 'delivery_schedule', label: 'Update program/service delivery schedule', type: 'checkbox' },
          { key: 'delivery_report', label: 'Prepare weekly program/service delivery report', type: 'checkbox' }
        ]
      },
      {
        title: 'Volunteer Management',
        fields: [
          { key: 'vol_training_sessions', label: 'Volunteer training sessions conducted', type: 'number' },
          { key: 'hours_recorded', label: 'Record volunteer hours worked', type: 'checkbox' },
          { key: 'volunteer_db', label: 'Update volunteer database', type: 'checkbox' },
          { key: 'volunteer_checkin', label: 'Conduct weekly check-in with volunteers', type: 'checkbox' },
          { key: 'volunteer_feedback', label: 'Log volunteer feedback and issues', type: 'checkbox' },
          { key: 'timesheets_approved', label: 'Review and approve volunteer timesheets', type: 'checkbox' },
          { key: 'appreciation_notes', label: 'Prepare volunteer appreciation notes/emails', type: 'checkbox' }
        ]
      },
      {
        title: 'Staff Management',
        fields: [
          { key: 'total_staff', label: 'Total number of staff', type: 'number' },
          { key: 'staff_attendance', label: 'Staff attendance records', type: 'text' },
          { key: 'staff_training', label: 'Staff training and development sessions', type: 'text' },
          { key: 'staff_incidents', label: 'Any staff incidents or issues reported', type: 'text' },
          { key: 'performance_reviews', label: 'Performance reviews conducted', type: 'text' }
        ]
      },
      {
        title: 'Financial Management',
        fields: [
          { key: 'donations_recorded', label: 'Record all donations received this week', type: 'checkbox' },
          { key: 'donor_db_donations', label: 'Update the donor database with new donations', type: 'checkbox' },
          { key: 'bank_reconciled', label: 'Reconcile bank statements', type: 'checkbox' },
          { key: 'financial_summary', label: 'Prepare weekly financial summary report', type: 'checkbox' },
          { key: 'expenses_verified', label: 'Verify and record all expenses', type: 'checkbox' },
          { key: 'petty_cash', label: 'Update petty cash log', type: 'checkbox' },
          { key: 'receipts_filed', label: 'Review and file receipts and invoices', type: 'checkbox' }
        ]
      },
      {
        title: 'Marketing & Communications',
        fields: [
          { key: 'website_updates', label: 'Website updates made', type: 'text' },
          { key: 'social_media_updated', label: 'Update social media channels with weekly activities', type: 'checkbox' },
          { key: 'engagement_stats', label: 'Record engagement statistics (likes, shares, comments)', type: 'text' },
          { key: 'traffic_logged', label: 'Log website traffic data', type: 'checkbox' },
          { key: 'media_coverage', label: 'Collect and archive media coverage', type: 'checkbox' },
          { key: 'marketing_report', label: 'Prepare weekly marketing and communications report', type: 'checkbox' },
          { key: 'press_approved', label: 'Review and approve press releases and newsletters', type: 'checkbox' }
        ]
      },
      {
        title: 'Risk Management',
        fields: [
          { key: 'hs_checks', label: 'Health and safety checks completed', type: 'text' },
          { key: 'risk_mitigation', label: 'Action taken to mitigate identified risks', type: 'text' },
          { key: 'acnc_compliance', label: 'Review compliance with ACNC standards', type: 'checkbox' },
          { key: 'compliance_issues', label: 'Log any compliance issues or breaches', type: 'checkbox' },
          { key: 'risk_register', label: 'Update risk register', type: 'checkbox' },
          { key: 'risk_assessment', label: 'Conduct weekly risk assessment', type: 'checkbox' }
        ]
      }
    ]
  }
};

export const WEEKLY_REPORT_TYPES = Object.keys(WEEKLY_REPORT_CONFIG);
