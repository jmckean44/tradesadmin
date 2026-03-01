document.addEventListener('astro:page-load', async () => {
	const root = document.getElementById('dashboard-root');
	if (!root) return;

	root.textContent = 'Loading...';

	try {
		const response = await fetch('/api/submissions');
		const data = await response.json();
		const submissions = Array.isArray(data) ? data : [];

		if (!submissions.length) {
			root.textContent = 'No submissions yet.';
			return;
		}

		const table = document.createElement('table');
		table.border = '1';
		table.cellPadding = '6';

		const thead = document.createElement('thead');
		const headRow = document.createElement('tr');
		['Date', 'Company', 'Email', 'URL', 'Status', 'Error', 'Results'].forEach((label) => {
			const th = document.createElement('th');
			th.textContent = label;
			headRow.appendChild(th);
		});
		thead.appendChild(headRow);
		table.appendChild(thead);

		const tbody = document.createElement('tbody');
		submissions.forEach((submission) => {
			const row = document.createElement('tr');
			const cells = [
				new Date(submission.submitted_at).toLocaleString(),
				submission.company || '',
				submission.email || '',
				submission.url || '',
				submission.error ? 'Failure' : 'Success',
				submission.error || '',
				submission.results ? JSON.stringify(submission.results) : '',
			];

			cells.forEach((value) => {
				const td = document.createElement('td');
				td.textContent = value;
				row.appendChild(td);
			});

			tbody.appendChild(row);
		});

		table.appendChild(tbody);
		root.innerHTML = '';
		root.appendChild(table);
	} catch {
		root.innerHTML = '<p style="color:red">Failed to load submissions</p>';
	}
});
