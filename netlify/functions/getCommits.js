export async function handler(event) {
  try {
    const { owner, repo, branch, since, until } = JSON.parse(event.body);
    const GIT_TOKEN = process.env.GITHUB_TOKEN;
    
    const url = `https://api.github.com/repos/${owner}/${repo}/commits?sha=${branch}&since=${since}&per_page=50`;

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${GIT_TOKEN}`,
        Accept: 'application/vnd.github+json'
      }
    });

    const data = await response.json();

    return {
      statusCode: 200,
      body: JSON.stringify(data)
    };

  } catch (error) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message })
    };
  }
}