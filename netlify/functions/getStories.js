const fetch = require("node-fetch");

exports.handler = async function () {
  try {
    

    const JIRA_API_TOKEN = process.env.JIRA_API_TOKEN;
    const jql = encodeURIComponent(
        'assignee = currentUser() AND issuetype = Story'
    );

   

    const response = await fetch(`https://vijaykrishnan.atlassian.net/rest/api/3/search/jql?jql=${jql}&fields=summary,description,status`, {
        method: 'GET',
        headers: {
            'Authorization': 'Basic ' + btoa(`soundarakrishna@gmail.com:${JIRA_API_TOKEN}`),
            'Accept': 'application/json'
        }
        });
    

    if (!response.ok) {
      throw new Error(`Jira API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    console.log('Jira response:', JSON.stringify(data, null, 2));

    if (!data.issues) {
      console.error('No issues in response:', data);
      throw new Error('Failed to fetch issues from Jira: ' + (data.errorMessages ? data.errorMessages.join(', ') : 'Unknown error'));
    }

    const stories = data.issues.map(issue => ({
      id: issue.key,
      title: issue.fields?.summary || 'No Title',
      description: parseADF(issue.fields?.description),
      status: issue.fields?.status?.name || 'Unknown'
    }));

    return {
      statusCode: 200,
      body: JSON.stringify({ stories })
    };

  } catch (error) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message })
    };
  }
};

function parseADF(description) {
  if (!description || !description.content) return '';

  return description.content
    .map(block =>
      (block.content || [])
        .map(c => c.text || '')
        .join('')
    )
    .join('\n');
}
