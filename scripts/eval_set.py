# ruff: noqa: E501  (data, copied verbatim)
"""The RAG app's eval set, copied unchanged from Gemini-Powered-RAG-System
(backend/eval/corpus.py and dataset.py): a fictional company handbook, one
passage per topic, and gold questions labelled with the passage that answers
them. `answerable=False` marks questions the handbook does not cover."""

CORPUS = [
    {
        "id": "pto",
        "text": "Paid Time Off. Full-time employees at Northwind Software accrue 20 days of paid vacation per year, on top of 10 company holidays. Vacation begins accruing on the first day of employment, and unused days roll over up to a maximum of 30 days.",
    },
    {
        "id": "remote",
        "text": "Remote Work. Northwind runs a hybrid model. Employees may work remotely up to three days a week but must be in the office on Tuesdays and Thursdays for team collaboration. Fully-remote arrangements require director approval.",
    },
    {
        "id": "health",
        "text": "Health Insurance. The company covers 100% of the employee medical and dental premium and 60% of the premium for dependents. Coverage starts on the first of the month following your start date. Open enrollment is each November.",
    },
    {
        "id": "expenses",
        "text": "Expense Reimbursement. To be reimbursed, submit receipts through the Expensify portal within 30 days of the purchase. Any expense over 75 dollars needs manager approval. Reimbursements are paid on the next payroll cycle.",
    },
    {
        "id": "conduct",
        "text": "Code of Conduct. Employees are expected to treat colleagues, customers, and partners with respect. Harassment, discrimination, and retaliation are strictly prohibited and may lead to termination. Concerns can be reported anonymously to the ethics hotline.",
    },
    {
        "id": "security",
        "text": "Information Security. Passwords must be at least 14 characters long and combine letters, numbers, and symbols. Multi-factor authentication is mandatory on all company systems. Never share credentials or store them in plaintext.",
    },
    {
        "id": "parental",
        "text": "Parental Leave. Northwind offers 16 weeks of fully-paid parental leave to every new parent, regardless of gender, after the birth or adoption of a child. Leave can be taken any time within the first year and may be split into two blocks.",
    },
    {
        "id": "reviews",
        "text": "Performance Reviews. Formal performance reviews happen twice a year, in June and December. Each review includes a self-assessment, peer feedback, and a manager evaluation. Promotion decisions are made during the December cycle.",
    },
    {
        "id": "equipment",
        "text": "Equipment. Every engineer receives a company laptop, an external monitor, and a 500 dollar home-office stipend. Hardware is refreshed every three years. Lost or damaged equipment must be reported to IT within 48 hours.",
    },
    {
        "id": "office",
        "text": "Office and Hours. Headquarters is at 500 Harbor Street in Seattle. Core working hours are 10am to 4pm Pacific, during which employees are expected to be reachable. The office has 24/7 badge access.",
    },
]

GOLD = [
    {
        "question": "How many paid vacation days do full-time employees get?",
        "relevant_ids": ["pto"],
        "answer_substring": "20",
        "answerable": True,
    },
    {
        "question": "Which days am I required to be in the office?",
        "relevant_ids": ["remote"],
        "answer_substring": "Tuesday",
        "answerable": True,
    },
    {
        "question": "How much of a dependent's health premium does the company cover?",
        "relevant_ids": ["health"],
        "answer_substring": "60",
        "answerable": True,
    },
    {
        "question": "What is the deadline to submit an expense for reimbursement?",
        "relevant_ids": ["expenses"],
        "answer_substring": "30 days",
        "answerable": True,
    },
    {
        "question": "How long is parental leave?",
        "relevant_ids": ["parental"],
        "answer_substring": "16 weeks",
        "answerable": True,
    },
    {
        "question": "What are the password requirements?",
        "relevant_ids": ["security"],
        "answer_substring": "14",
        "answerable": True,
    },
    {
        "question": "When are performance reviews held?",
        "relevant_ids": ["reviews"],
        "answer_substring": "June",
        "answerable": True,
    },
    {
        "question": "What home-office stipend do engineers receive?",
        "relevant_ids": ["equipment"],
        "answer_substring": "500",
        "answerable": True,
    },
    {
        "question": "Where is the company headquarters located?",
        "relevant_ids": ["office"],
        "answer_substring": "Seattle",
        "answerable": True,
    },
    # Out-of-scope: not covered by the handbook — the system should abstain.
    {
        "question": "What is the company's stock ticker symbol?",
        "relevant_ids": [],
        "answer_substring": None,
        "answerable": False,
    },
    {
        "question": "Who won the FIFA World Cup in 2018?",
        "relevant_ids": [],
        "answer_substring": None,
        "answerable": False,
    },
    {
        "question": "What is the recipe for a chocolate souffle?",
        "relevant_ids": [],
        "answer_substring": None,
        "answerable": False,
    },
]
