import axios from './axios'

// The page that hosts the app can serve the bundled data from elsewhere (window.PPTIST_BASE).
const base = () => (window as any).PPTIST_BASE ?? './'

export default {
  getMockData(filename: string): Promise<any> {
    return axios.get(`${base()}mocks/${filename}.json`)
  },
}
